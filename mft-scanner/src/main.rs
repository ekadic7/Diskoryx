use ntfs_reader::{
    DefaultPathCache, MftScan, NtfsAttributeType, NtfsFile, NtfsFileName, Volume, ROOT_RECORD,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::error::Error;
use std::io::{self, BufWriter, Write};
use std::time::{Duration, Instant};

// Wire format shared with src/main/mft-scanner.js. Bump both sides together.
const FORMAT_MAGIC: &[u8; 4] = b"DXM2";
const FORMAT_VERSION: u32 = 2;
// ntfs-reader's live listing starts at record 24, but its children still refer here.
const EXTEND_RECORD: u64 = 11;

/// Full references include the sequence number, so a reused slot is not its old parent.
struct FolderEntry {
    reference: u64,
    parent_reference: u64,
    name: String,
    file_attributes: u32,
}

/// One hard-link name of a file. Emitted after all directories are known.
struct FileEntry {
    parent_reference: u64,
    name: String,
    size: u64,
    modified_ms: Option<i64>,
    file_attributes: u32,
    hard_link_count: u16,
    size_owner: bool,
}

#[derive(Serialize)]
struct Summary {
    #[serde(rename = "type")]
    record_type: &'static str,
    #[serde(rename = "recordSlots")]
    record_slots: u64,
    files: u64,
    directories: u64,
    #[serde(rename = "unresolvedPaths")]
    unresolved_paths: u64,
    #[serde(rename = "logicalBytes")]
    logical_bytes: u64,
    #[serde(rename = "corruptRecords")]
    corrupt_records: u64,
    #[serde(rename = "memoryBytes")]
    memory_bytes: usize,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: f64,
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

/// Size of the default data stream, modification time and attributes, without
/// resolving a path (that resolution was the scanner's largest CPU cost).
fn summarize(file: &NtfsFile) -> (u64, Option<i64>, u32) {
    let mut size = 0_u64;
    let mut standard_information = None;
    for attribute in file.attributes() {
        match attribute.attribute_type() {
            Some(NtfsAttributeType::StandardInformation) => {
                standard_information = attribute.standard_information();
            }
            Some(NtfsAttributeType::Data) if attribute.name().is_none() => {
                if let Some(value_size) = attribute.value_size() {
                    size = value_size;
                }
            }
            _ => {}
        }
    }
    let modified_ms = standard_information
        .map(|info| (info.modified().unix_timestamp_nanos() / 1_000_000) as i64);
    let file_attributes = standard_information.map_or(0, |info| info.file_attributes());
    (size, modified_ms, file_attributes)
}

fn write_name(output: &mut impl Write, name: &str) -> io::Result<()> {
    let bytes = name.as_bytes();
    let length = u16::try_from(bytes.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "MFT name exceeds the format limit",
        )
    })?;
    output.write_all(&length.to_le_bytes())?;
    output.write_all(bytes)
}

struct FolderIndex<'a> {
    ordered: Vec<(u32, &'a FolderEntry)>,
    ids: HashMap<u64, u32>,
}

fn order_folders(folders: &[FolderEntry], root_reference: u64) -> FolderIndex<'_> {
    let mut children_by_parent: HashMap<u64, Vec<usize>> = HashMap::with_capacity(folders.len());
    for (index, folder) in folders.iter().enumerate() {
        children_by_parent
            .entry(folder.parent_reference)
            .or_default()
            .push(index);
    }
    let mut ids = HashMap::with_capacity(folders.len() + 1);
    ids.insert(root_reference, 0);
    let mut references = vec![root_reference];
    let mut ordered = Vec::with_capacity(folders.len());
    let mut queue = VecDeque::from([0_u32]);
    while let Some(parent_id) = queue.pop_front() {
        let reference = references[parent_id as usize];
        if let Some(child_indices) = children_by_parent.remove(&reference) {
            for index in child_indices {
                let child = &folders[index];
                if ids.contains_key(&child.reference) {
                    continue;
                }
                let id = references.len() as u32;
                references.push(child.reference);
                ids.insert(child.reference, id);
                ordered.push((parent_id, child));
                queue.push_back(id);
            }
        }
    }
    FolderIndex { ordered, ids }
}

fn select_files<'a>(
    files: &'a mut [FileEntry],
    folder_ids: &HashMap<u64, u32>,
    unresolved_paths: &mut u64,
) -> (Vec<(u32, &'a FileEntry)>, u64) {
    let mut emitted_files = Vec::with_capacity(files.len());
    let mut logical_bytes = 0_u64;
    let mut needs_owner = false;
    for file in files.iter_mut() {
        // Input links are contiguous per file; the first sorted link starts a group.
        if file.size_owner {
            needs_owner = true;
        }
        file.size_owner = false;
        match folder_ids.get(&file.parent_reference) {
            Some(parent_id) => {
                file.size_owner = needs_owner;
                needs_owner = false;
                if file.size_owner {
                    logical_bytes += file.size;
                }
                emitted_files.push((*parent_id, &*file));
            }
            None => *unresolved_paths += 1,
        }
    }
    (emitted_files, logical_bytes)
}

fn scan(volume_path: &str) -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    eprintln!("Opening {volume_path} and reading the MFT in chunks...");
    let volume = Volume::new(volume_path)?;
    let mut scan = MftScan::new(volume)?;
    let total_records = scan.record_count();
    let opened = Instant::now();
    eprintln!("Scanning {total_records} MFT record slots in chunks...");

    let mut folders: Vec<FolderEntry> = Vec::with_capacity(200_000);
    let mut files: Vec<FileEntry> = Vec::with_capacity(800_000);
    let mut seen_directories: HashSet<u64> = HashSet::with_capacity(200_000);
    let mut unresolved_paths = 0_u64;
    let mut files_seen = 0_u64;
    let mut directories_seen = 0_u64;
    let mut last_report = Instant::now();
    let mut root_reference = None;
    let mut extend_folder = None;
    let mut path_cache = DefaultPathCache::new();

    while let Some(chunk) = scan.next_chunk()? {
        if root_reference.is_none() {
            root_reference = chunk
                .record(ROOT_RECORD)
                .filter(|file| file.is_used() && file.is_directory() && !file.is_extension())
                .map(|file| file.reference());
        }
        if chunk.records().contains(&EXTEND_RECORD) {
            extend_folder = chunk
                .record(EXTEND_RECORD)
                .filter(|file| file.is_used() && file.is_directory() && !file.is_extension())
                .and_then(|file| {
                    let name = file.best_name()?;
                    Some(FolderEntry {
                        reference: file.reference(),
                        parent_reference: name.parent_reference(),
                        name: name.to_string(),
                        file_attributes: summarize(&file).2,
                    })
                });
        }
        let records_scanned = chunk.records().end;
        for file in chunk.files() {
            let is_directory = file.is_directory();
            let reference = file.reference();
            let (size, modified_ms, file_attributes) = summarize(&file);
            let mut links: Vec<NtfsFileName> = file.hard_links().collect();
            if links.is_empty() {
                if let Some(name) = file.best_name() {
                    links.push(name);
                }
            }
            if links.is_empty() {
                unresolved_paths += 1;
                continue;
            }
            if is_directory {
                if file.number() == ROOT_RECORD || !seen_directories.insert(reference) {
                    continue;
                }
                directories_seen += 1;
                let name = file.best_name().unwrap_or(links[0]);
                folders.push(FolderEntry {
                    reference,
                    parent_reference: name.parent_reference(),
                    name: name.to_string(),
                    file_attributes,
                });
            } else {
                files_seen += 1;
                let hard_link_count = links.len().min(u16::MAX as usize) as u16;
                if links.len() > 1 {
                    // Preserve the old deterministic full-path ownership rule only
                    // where needed; single-link files still avoid path resolution.
                    let mut resolved = Vec::with_capacity(links.len());
                    for name in links {
                        if let Some(path) = chunk.resolve_path(&name, &mut path_cache) {
                            resolved.push((path.to_string_lossy().to_lowercase(), name));
                        } else {
                            unresolved_paths += 1;
                        }
                    }
                    resolved.sort_by(|left, right| left.0.cmp(&right.0));
                    links = resolved.into_iter().map(|(_, name)| name).collect();
                }
                for (index, name) in links.iter().enumerate() {
                    files.push(FileEntry {
                        parent_reference: name.parent_reference(),
                        name: name.to_string(),
                        size,
                        modified_ms,
                        file_attributes,
                        hard_link_count,
                        size_owner: index == 0,
                    });
                }
            }
        }
        emit_progress(
            &mut last_report,
            started,
            records_scanned,
            total_records,
            files_seen,
            directories_seen,
        );
    }

    let scanned = Instant::now();
    let root_reference = root_reference.ok_or("The live NTFS root reference is unavailable")?;

    // Use actual reserved metadata, including its sequence and parent, not a
    // fabricated reference that would let stale links attach to a reused slot.
    if let Some(folder) = extend_folder {
        if folders
            .iter()
            .any(|child| child.parent_reference == folder.reference)
            || files
                .iter()
                .any(|file| file.parent_reference == folder.reference)
        {
            folders.push(folder);
        }
    }

    let FolderIndex {
        ordered: ordered_folders,
        ids: folder_ids,
    } = order_folders(&folders, root_reference);
    // Directories whose parent chain is missing cannot be reached from the root.
    unresolved_paths += (folders.len() - ordered_folders.len()) as u64;

    let treed = Instant::now();

    let (emitted_files, logical_bytes) =
        select_files(&mut files, &folder_ids, &mut unresolved_paths);

    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(1024 * 1024, stdout.lock());
    output.write_all(FORMAT_MAGIC)?;
    output.write_all(&FORMAT_VERSION.to_le_bytes())?;
    output.write_all(&(ordered_folders.len() as u32).to_le_bytes())?;
    for (parent_id, folder) in &ordered_folders {
        output.write_all(&parent_id.to_le_bytes())?;
        output.write_all(&folder.file_attributes.to_le_bytes())?;
        write_name(&mut output, &folder.name)?;
    }
    output.write_all(&(emitted_files.len() as u32).to_le_bytes())?;
    for (parent_id, file) in &emitted_files {
        let flags = (if file.size_owner { 1_u8 } else { 0 })
            | (if file.modified_ms.is_some() { 2 } else { 0 });
        output.write_all(&parent_id.to_le_bytes())?;
        output.write_all(&file.size.to_le_bytes())?;
        output.write_all(&file.modified_ms.unwrap_or(0).to_le_bytes())?;
        output.write_all(&file.file_attributes.to_le_bytes())?;
        output.write_all(&file.hard_link_count.to_le_bytes())?;
        output.write_all(&[flags])?;
        write_name(&mut output, &file.name)?;
    }

    serde_json::to_writer(
        &mut output,
        &Summary {
            record_type: "summary",
            record_slots: total_records,
            files: emitted_files.len() as u64,
            directories: ordered_folders.len() as u64,
            unresolved_paths,
            logical_bytes,
            corrupt_records: scan.corrupt_records(),
            memory_bytes: scan.size_in_memory(),
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        },
    )?;
    output.write_all(b"\n")?;
    output.flush()?;
    eprintln!(
        "Timing: open={}ms scan={}ms tree={}ms emit={}ms files={} folders={} unresolved={}",
        opened.duration_since(started).as_millis(),
        scanned.duration_since(opened).as_millis(),
        treed.duration_since(scanned).as_millis(),
        Instant::now().duration_since(treed).as_millis(),
        emitted_files.len(),
        ordered_folders.len(),
        unresolved_paths,
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    fn file(parent: u64, size_owner: bool) -> FileEntry {
        FileEntry {
            parent_reference: parent,
            name: "alias.txt".into(),
            size: 12345,
            modified_ms: None,
            file_attributes: 0,
            hard_link_count: 2,
            size_owner,
        }
    }

    #[test]
    fn surviving_link_takes_ownership_when_first_parent_is_missing() {
        let mut files = vec![file(999, true), file(ROOT_RECORD, false)];
        let ids = HashMap::from([(ROOT_RECORD, 0)]);
        let mut unresolved = 0;
        let (emitted, bytes) = select_files(&mut files, &ids, &mut unresolved);
        assert_eq!(emitted.len(), 1);
        assert_eq!(unresolved, 1);
        assert_eq!(bytes, 12345);
        assert!(emitted[0].1.size_owner);
    }

    #[test]
    fn each_link_group_is_counted_once_and_missing_groups_do_not_spill() {
        let mut files = vec![
            file(999, true),
            file(998, false),
            file(ROOT_RECORD, true),
            file(ROOT_RECORD, false),
            file(997, true),
            file(ROOT_RECORD, false),
        ];
        let ids = HashMap::from([(ROOT_RECORD, 0)]);
        let mut unresolved = 0;
        let (emitted, bytes) = select_files(&mut files, &ids, &mut unresolved);
        assert_eq!(emitted.len(), 3);
        assert_eq!(unresolved, 3);
        assert_eq!(bytes, 24690);
        assert_eq!(
            emitted.iter().filter(|(_, file)| file.size_owner).count(),
            2
        );
    }

    fn reference(sequence: u16, number: u64) -> u64 {
        (u64::from(sequence) << 48) | number
    }

    fn folder(reference: u64, parent_reference: u64) -> FolderEntry {
        FolderEntry {
            reference,
            parent_reference,
            name: "folder".into(),
            file_attributes: 0,
        }
    }

    #[test]
    fn reused_directory_slot_does_not_accept_a_stale_file_or_subtree() {
        let root = reference(1, ROOT_RECORD);
        let current = reference(8, 42);
        let stale = reference(7, 42);
        let folders = vec![folder(current, root), folder(reference(1, 43), stale)];
        let index = order_folders(&folders, root);
        assert_eq!(index.ordered.len(), 1);
        assert!(index.ids.contains_key(&current));
        assert!(!index.ids.contains_key(&stale));
        let mut files = vec![file(stale, true), file(current, false)];
        let mut unresolved = 0;
        let (emitted, bytes) = select_files(&mut files, &index.ids, &mut unresolved);
        assert_eq!(emitted.len(), 1);
        assert_eq!(unresolved, 1);
        assert_eq!(bytes, 12345);
    }

    #[test]
    fn root_sequence_is_checked_and_cycles_remain_unreachable() {
        let root = reference(2, ROOT_RECORD);
        let folders = vec![
            folder(reference(1, 24), reference(1, ROOT_RECORD)),
            folder(reference(1, 25), reference(1, 26)),
            folder(reference(1, 26), reference(1, 25)),
            folder(reference(1, 27), root),
        ];
        let index = order_folders(&folders, root);
        assert_eq!(index.ordered.len(), 1);
        assert_eq!(index.ordered[0].1.reference, reference(1, 27));
    }

    #[test]
    fn reserved_extend_reference_and_parent_before_child_order_are_preserved() {
        let root = reference(1, ROOT_RECORD);
        let extend = reference(3, EXTEND_RECORD);
        let nested = reference(9, 30);
        let folders = vec![folder(nested, extend), folder(extend, root)];
        let index = order_folders(&folders, root);
        assert_eq!(index.ordered.len(), 2);
        assert_eq!(index.ordered[0].0, 0);
        assert_eq!(index.ordered[0].1.reference, extend);
        assert_eq!(index.ordered[1].0, 1);
        let mut files = vec![file(nested, true), file(reference(2, EXTEND_RECORD), true)];
        let mut unresolved = 0;
        let (emitted, bytes) = select_files(&mut files, &index.ids, &mut unresolved);
        assert_eq!(emitted.len(), 1);
        assert_eq!(bytes, 12345);
        assert_eq!(unresolved, 1);
    }

    #[test]
    fn oversized_names_are_refused_instead_of_truncated() {
        assert!(write_name(&mut Vec::new(), &"x".repeat(65536)).is_err());
        let mut output = Vec::new();
        write_name(&mut output, "日本語").unwrap();
        assert_eq!(u16::from_le_bytes([output[0], output[1]]), 9);
        assert_eq!(&output[2..], "日本語".as_bytes());
    }
}
