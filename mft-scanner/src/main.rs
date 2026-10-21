use ntfs_reader::{DefaultPathCache, FileInfo, MftScan, Volume};
use serde::Serialize;
use serde_json::json;
use std::{
    env,
    error::Error,
    io::{self, BufWriter, Write},
    time::{Duration, Instant},
};

#[derive(Serialize)]
struct EntryLine<'a> {
    #[serde(rename = "type")]
    record_type: &'static str,
    path: &'a str,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    size: u64,
    #[serde(rename = "sizeOwner")]
    size_owner: bool,
    #[serde(rename = "hardLinkCount")]
    hard_link_count: usize,
    #[serde(rename = "modifiedMs")]
    modified_ms: Option<i64>,
    #[serde(rename = "fileAttributes")]
    file_attributes: u32,
}

fn emit_progress(
    last_report: &mut Instant,
    started: Instant,
    records_scanned: u64,
    total_records: u64,
    files: u64,
    directories: u64,
) {
    if last_report.elapsed() >= Duration::from_secs(2) {
        eprintln!(
            "Progress: {records_scanned}/{total_records} MFT records, {files} files, {directories} directories, {:.0?} elapsed",
            started.elapsed()
        );
        *last_report = Instant::now();
    }
}

fn scan(volume_path: &str) -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    eprintln!("Opening {volume_path} and reading the MFT in chunks...");
    let volume = Volume::new(volume_path)?;
    eprintln!("Starting MFT pass 1 (directory and extension metadata)...");
    let mut scan = MftScan::new(volume)?;
    let total_records = scan.record_count();
    eprintln!("Pass 1 complete; scanning {total_records} MFT record slots in chunks...");

    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(1024 * 1024, stdout.lock());
    let mut path_cache = DefaultPathCache::new();
    let mut directories = 0_u64;
    let mut files = 0_u64;
    let mut unresolved_paths = 0_u64;
    let mut logical_bytes = 0_u64;
    let mut last_report = Instant::now();

    while let Some(chunk) = scan.next_chunk()? {
        let records_scanned = chunk.records().end;
        for file in chunk.files() {
            let info = FileInfo::with_cache(&file, &mut path_cache);
            let modified_ms = info
                .modified
                .map(|time| (time.unix_timestamp_nanos() / 1_000_000) as i64);
            let links = file.hard_links().collect::<Vec<_>>();
            let hard_link_count = links.len();
            let mut paths = Vec::with_capacity(hard_link_count.max(1));
            for link in &links {
                if let Some(path) = chunk.resolve_path(link, &mut path_cache) {
                    paths.push(path);
                } else {
                    unresolved_paths += 1;
                }
            }
            if paths.is_empty() {
                if let Some(path) = info.path.as_ref() {
                    paths.push(path.clone());
                } else {
                    unresolved_paths += 1;
                    continue;
                }
            }
            paths.sort_by_key(|path| path.to_string_lossy().to_lowercase());

            let path_count = paths.len();
            for (link_index, path) in paths.iter().enumerate() {
                let rendered_path = path.to_string_lossy();
                let full_path = rendered_path
                    .strip_prefix(r"\\.\")
                    .unwrap_or(rendered_path.as_ref());
                let size_owner = info.is_directory || link_index == 0;
                if info.is_directory {
                    directories += 1;
                } else {
                    files += 1;
                    if size_owner {
                        logical_bytes += info.size;
                    }
                }

                serde_json::to_writer(
                    &mut output,
                    &EntryLine {
                        record_type: "entry",
                        path: full_path,
                        is_directory: info.is_directory,
                        size: info.size,
                        size_owner,
                        hard_link_count: path_count.max(hard_link_count),
                        modified_ms,
                        file_attributes: info.file_attributes,
                    },
                )?;
                output.write_all(b"\n")?;
            }
        }
        output.flush()?;
        emit_progress(
            &mut last_report,
            started,
            records_scanned,
            total_records,
            files,
            directories,
        );
    }

    serde_json::to_writer(
        &mut output,
        &json!({
            "type": "summary",
            "recordSlots": total_records,
            "files": files,
            "directories": directories,
            "unresolvedPaths": unresolved_paths,
            "logicalBytes": logical_bytes,
            "corruptRecords": scan.corrupt_records(),
            "memoryBytes": scan.size_in_memory(),
            "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
        }),
    )?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn main() {
    let Some(volume_path) = env::args().nth(1) else {
        eprintln!("Usage: diskoryx-mft-scanner <raw-volume-path>");
        eprintln!(r"Example: diskoryx-mft-scanner \\.\C:");
        std::process::exit(2);
    };

    if let Err(error) = scan(&volume_path) {
        eprintln!("Scan failed: {error}");
        std::process::exit(1);
    }
}
