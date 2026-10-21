using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

internal static partial class Program
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle source,
        IntPtr destinationProcess, out SafeFileHandle duplicate, uint access, bool inherit, uint options);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateDirectoryW(string name, IntPtr security);
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private struct StreamInformation
    {
        public long Size;
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.ByValTStr, SizeConst = 296)]
        public string Name;
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstStreamW(string name, int level, out StreamInformation data, uint flags);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern bool FindNextStreamW(IntPtr search, out StreamInformation data);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool FindClose(IntPtr search);

    private static void RejectUnsupportedStreams(string name, uint attributes)
    {
        if ((attributes & 0x4000) != 0)
            throw new IOException("Diskoryx refuses EFS-encrypted items instead of silently removing their encryption.");
        StreamInformation stream;
        IntPtr search = FindFirstStreamW(@"\\?\" + name, 0, out stream, 0);
        if (search == new IntPtr(-1))
        {
            int error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
            if (error == 38 || error == 1 || error == 50 || error == 87)
                return; // Some filesystems report unsupported stream enumeration as ERROR_INVALID_PARAMETER.
            throw new System.ComponentModel.Win32Exception(error,
                "Unable to inspect alternate data streams for " + name + " (Windows error " + error + ").");
        }
        try
        {
            do
            {
                if (stream.Name != "::$DATA")
                    throw new IOException("Diskoryx refuses alternate data streams instead of silently dropping them. Use Windows Explorer to copy this item.");
            } while (FindNextStreamW(search, out stream));
            int error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
            if (error != 38) throw new System.ComponentModel.Win32Exception(error, "Unable to enumerate alternate data streams.");
        }
        finally { FindClose(search); }
    }

    private static SafeFileHandle DuplicateReadHandle(SafeFileHandle source)
    {
        SafeFileHandle duplicate;
        Check(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out duplicate, 0, false, 2),
            "Unable to retain source copy lock");
        return duplicate;
    }
    public sealed class CopyRequest
    {
        public string root { get; set; }
        public string target { get; set; }
        public string destination { get; set; }
        public string name { get; set; }
        public Entry[] entries { get; set; }
        public Entry[] destinationEntries { get; set; }
        public bool move { get; set; }
    }

    private sealed class CopyNode
    {
        public string Source;
        public string Relative;
        public bool Directory;
        public SafeFileHandle Handle;
        public long Length;
        public DateTime Modified;
    }

    private static Entry CreatedEntry(string name, SafeFileHandle handle, bool directory)
    {
        FileInformation info;
        Check(GetFileInformationByHandle(handle, out info), "Unable to remember copied item identity");
        return new Entry {
            path = name, inode = (((ulong)info.FileIndexHigh << 32) | info.FileIndexLow).ToString(),
            volume = info.VolumeSerialNumber.ToString(), isDirectory = directory
        };
    }

    private static void RemoveCreated(Entry entry)
    {
        using (SafeFileHandle handle = Open(entry.path, true, entry))
        {
            IntPtr buffer = System.Runtime.InteropServices.Marshal.AllocHGlobal(1);
            try
            {
                System.Runtime.InteropServices.Marshal.WriteByte(buffer, 1);
                Check(SetFileInformationByHandle(handle, 4, buffer, 1), "Unable to remove own incomplete copied item");
            }
            finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(buffer); }
        }
    }

    private static SafeFileHandle ReadCopyNode(string name, out FileInformation information, bool moving = false)
    {
        SafeFileHandle handle = CreateFileW(@"\\?\" + name, 0x80000000 | (moving ? DeleteAccess : 0), ShareRead,
            IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
        try
        {
            Check(!handle.IsInvalid, "Unable to read-lock copy source");
            Check(GetFileInformationByHandle(handle, out information), "Unable to inspect copy source");
            if ((information.Attributes & ReparseAttribute) != 0)
                throw new InvalidOperationException("Copy refuses links and junctions, including descendants.");
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }

    private static void PinChain(string target, Entry[] entries, List<SafeFileHandle> locks)
    {
        string current = Path.GetPathRoot(target);
        string suffix = target.Substring(current.Length);
        string[] components = suffix.Length == 0 ? new string[0] : suffix.Split('\\');
        if (entries == null || entries.Length != components.Length)
            throw new InvalidOperationException("Incomplete copy identity chain.");
        locks.Add(Open(current, false, null));
        for (int index = 0; index < components.Length; index++)
        {
            current = Path.Combine(current, components[index]);
            Entry expected = entries[index];
            if (expected == null || !String.Equals(current, expected.path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Invalid copy identity chain.");
            if (index == components.Length - 1 && !expected.isDirectory)
            {
                FileInformation information;
                SafeFileHandle handle = ReadCopyNode(current, out information);
                locks.Add(handle);
                string inode = (((ulong)information.FileIndexHigh << 32) | information.FileIndexLow).ToString();
                if (expected.inode != inode || expected.volume != information.VolumeSerialNumber.ToString())
                    throw new InvalidOperationException("Copy source changed.");
            }
            else locks.Add(Open(current, false, expected));
        }
    }

    private static int CopyMain()
    {
        Console.InputEncoding = new System.Text.UTF8Encoding(false);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        List<SafeFileHandle> locks = new List<SafeFileHandle>();
        List<CopyNode> nodes = new List<CopyNode>();
        List<Entry> createdFiles = new List<Entry>();
        List<Entry> createdDirectories = new List<Entry>();
        List<SafeFileHandle> stageLocks = new List<SafeFileHandle>();
        WindowsImpersonationContext identity = null;
        string stage = null;
        bool published = false;
        string finalPath = null;
        bool moving = false;
        try
        {
            string line = Console.ReadLine();
            if (line == null || line.Length > 262144) throw new InvalidOperationException("Invalid copy request.");
            CopyRequest request = Json.Deserialize<CopyRequest>(line);
            moving = request.move;
            string source = Normalize(request.target);
            string root = Normalize(request.root);
            string destination = Normalize(request.destination).TrimEnd('\\') + "\\";
            ValidateName(request.name);
            if (!source.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Copy source is outside the scanned location.");
            if (destination.StartsWith(source.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Cannot copy a folder into itself or its descendants.");
            identity = UseStandardRenameRights();
            if (moving)
            {
                Entry[] parents = new Entry[request.entries.Length - 1];
                Array.Copy(request.entries, parents, parents.Length);
                PinChain(Path.GetDirectoryName(source), parents, locks);
            }
            else PinChain(source, request.entries, locks);
            PinChain(destination.Length == 3 ? destination : destination.TrimEnd('\\'), request.destinationEntries, locks);
            string final = Path.Combine(destination, request.name);
            finalPath = final;
            if (File.Exists(final) || Directory.Exists(final)) throw new IOException("The destination already exists; nothing was overwritten.");
            if (moving)
            {
                using (SafeFileHandle sourceLeaf = Open(source, true, request.entries[request.entries.Length - 1]))
                using (SafeFileHandle destinationFolder = Open(destination.Length == 3 ? destination : destination.TrimEnd('\\'), false, null))
                {
                    FileInformation sourceInfo, destinationInfo;
                    Check(GetFileInformationByHandle(sourceLeaf, out sourceInfo), "Unable to inspect move source");
                    Check(GetFileInformationByHandle(destinationFolder, out destinationInfo), "Unable to inspect move destination");
                    if (sourceInfo.VolumeSerialNumber == destinationInfo.VolumeSerialNumber)
                    {
                        Console.WriteLine(Json.Serialize(new { ready = true, copyUsesStandardRights = true }));
                        if (Console.ReadLine() != "commit") return 0;
                        Rename(sourceLeaf, final);
                        Console.WriteLine(Json.Serialize(new { success = true, path = final, moved = true }));
                        return 0;
                    }
                }
            }
            Console.WriteLine(Json.Serialize(new { ready = true, copyUsesStandardRights = true }));
            if (Console.ReadLine() != "commit") return 0;
            int cancelled = 0;
            Thread monitor = new Thread(delegate() {
                // EOF also cancels when Electron exits; no unowned background copy continues.
                Console.ReadLine();
                Interlocked.Exchange(ref cancelled, 1);
            });
            monitor.IsBackground = true;
            monitor.Start();
            Action check = delegate() {
                if (Interlocked.CompareExchange(ref cancelled, 0, 0) != 0)
                    throw new OperationCanceledException("Copy cancelled.");
            };
            Stack<string> pending = new Stack<string>();
            pending.Push(source);
            long total = 0;
            while (pending.Count != 0)
            {
                check();
                if (nodes.Count >= 4096) throw new IOException("Diskoryx supports at most 4096 entries in one copy. Copy smaller folders separately.");
                string current = pending.Pop();
                FileInformation info;
                SafeFileHandle handle = ReadCopyNode(current, out info, moving);
                locks.Add(handle);
                bool directory = (info.Attributes & DirectoryAttribute) != 0;
                if (moving && !directory && info.NumberOfLinks > 1)
                    throw new IOException("Cross-volume Move refuses hard-linked files instead of changing their ownership.");
                if (current == source)
                {
                    Entry expectedSource = request.entries[request.entries.Length - 1];
                    string inode = (((ulong)info.FileIndexHigh << 32) | info.FileIndexLow).ToString();
                    if (expectedSource.inode != inode || expectedSource.volume != info.VolumeSerialNumber.ToString())
                        throw new IOException("Move source changed before locking.");
                }
                RejectUnsupportedStreams(current, info.Attributes);
                long length = ((long)info.FileSizeHigh << 32) | info.FileSizeLow;
                nodes.Add(new CopyNode {
                    Source = current, Relative = current == source ? "" : current.Substring(source.Length + 1),
                    Directory = directory, Handle = handle, Length = directory ? 0 : length,
                    Modified = File.GetLastWriteTimeUtc(current)
                });
                if (directory)
                {
                    foreach (string child in Directory.EnumerateFileSystemEntries(current))
                    {
                        if (nodes.Count + pending.Count >= 4096)
                            throw new IOException("Diskoryx supports at most 4096 entries in one copy. Copy smaller folders separately.");
                        pending.Push(child);
                    }
                }
                else total = checked(total + length);
            }
            bool sourceDirectory = nodes[0].Directory;
            stage = Path.Combine(destination, ".diskoryx-copy-" + Guid.NewGuid().ToString("N"));
            Console.WriteLine(Json.Serialize(new { progress = true, stage = stage, bytes = 0L, totalBytes = total }));
            long copied = 0;
            DateTime lastProgress = DateTime.UtcNow;
            byte[] buffer = new byte[1024 * 1024];
            foreach (CopyNode node in nodes)
            {
                check();
                string output = node.Relative.Length == 0 ? stage : Path.Combine(stage, node.Relative);
                if (node.Directory)
                {
                    if (Directory.Exists(output) || File.Exists(output)) throw new IOException("Copy staging path is occupied.");
                    Check(CreateDirectoryW(@"\\?\" + output, IntPtr.Zero), "Unable to exclusively create copy staging directory");
                    SafeFileHandle guard = Open(output, false, null);
                    stageLocks.Add(guard);
                    createdDirectories.Add(CreatedEntry(output, guard, true));
                }
                else
                {
                    using (FileStream input = new FileStream(DuplicateReadHandle(node.Handle), FileAccess.Read, 65536, false))
                    using (FileStream result = new FileStream(output, FileMode.CreateNew, moving ? FileAccess.ReadWrite : FileAccess.Write, FileShare.None, 65536))
                    using (System.Security.Cryptography.SHA256 hash = System.Security.Cryptography.SHA256.Create())
                    {
                        createdFiles.Add(CreatedEntry(output, result.SafeFileHandle, false));
                        int read;
                        while ((read = input.Read(buffer, 0, buffer.Length)) != 0)
                        {
                            check();
                            result.Write(buffer, 0, read);
                            if (moving) hash.TransformBlock(buffer, 0, read, buffer, 0);
                            copied += read;
                            if ((DateTime.UtcNow - lastProgress).TotalMilliseconds >= 200)
                            {
                                Console.WriteLine(Json.Serialize(new { progress = true, stage = stage, bytes = copied, totalBytes = total }));
                                lastProgress = DateTime.UtcNow;
                            }
                        }
                        result.Flush(true);
                        if (moving)
                        {
                            hash.TransformFinalBlock(new byte[0], 0, 0);
                            byte[] expectedHash = hash.Hash;
                            result.Position = 0;
                            byte[] writtenHash;
                            using (System.Security.Cryptography.SHA256 verify = System.Security.Cryptography.SHA256.Create())
                                writtenHash = verify.ComputeHash(result);
                            if (!System.Linq.Enumerable.SequenceEqual(expectedHash, writtenHash))
                                throw new IOException("Destination verification failed. The source was not removed.");
                        }
                    }
                    File.SetLastWriteTimeUtc(output, node.Modified);
                }
            }
            check();
            // Recheck source directory membership before publishing; a directory handle
            // pins its name but does not freeze concurrent child additions.
            HashSet<string> expected = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (CopyNode node in nodes) expected.Add(node.Source);
            foreach (CopyNode node in nodes)
                if (node.Directory)
                    foreach (string child in Directory.EnumerateFileSystemEntries(node.Source))
                        if (!expected.Contains(child)) throw new IOException("Source folder contents changed while copying. Retry after they stop changing.");
            HashSet<string> stageNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Entry entry in createdFiles) stageNames.Add(entry.path);
            foreach (Entry entry in createdDirectories) stageNames.Add(entry.path);
            foreach (Entry entry in createdDirectories)
                foreach (string child in Directory.EnumerateFileSystemEntries(entry.path))
                    if (!stageNames.Contains(child)) throw new IOException("Copy staging contents changed. The destination was not published.");
            for (int index = stageLocks.Count - 1; index >= 0; index--) stageLocks[index].Dispose();
            stageLocks.Clear();
            // Verify the stage still consists only of our own identities before no-replace publication.
            foreach (Entry entry in createdFiles)
                using (SafeFileHandle guard = Open(entry.path, true, entry)) { }
            foreach (Entry entry in createdDirectories)
                using (SafeFileHandle guard = Open(entry.path, true, entry)) { }
            if (sourceDirectory) Directory.Move(stage, final);
            else File.Move(stage, final);
            published = true;
            if (moving)
            {
                List<SafeFileHandle> destinationLocks = new List<SafeFileHandle>();
                try
                {
                    Dictionary<string, HashSet<string>> expectedChildren =
                        new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
                    foreach (CopyNode node in nodes)
                    {
                        if (node.Relative.Length == 0) continue;
                        string parent = Path.GetDirectoryName(node.Relative) ?? "";
                        HashSet<string> children;
                        if (!expectedChildren.TryGetValue(parent, out children))
                        {
                            children = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                            expectedChildren.Add(parent, children);
                        }
                        children.Add(Path.GetFileName(node.Relative));
                    }
                    foreach (CopyNode node in nodes)
                    {
                        string copiedPath = node.Relative.Length == 0 ? final : Path.Combine(final, node.Relative);
                        FileInformation info;
                        SafeFileHandle guard = ReadCopyNode(copiedPath, out info);
                        destinationLocks.Add(guard);
                        bool directory = (info.Attributes & DirectoryAttribute) != 0;
                        Entry expectedCopy = (node.Directory ? createdDirectories : createdFiles).Find(entry =>
                            String.Equals(entry.path, node.Relative.Length == 0 ? stage : Path.Combine(stage, node.Relative), StringComparison.OrdinalIgnoreCase));
                        if (directory != node.Directory || expectedCopy == null
                            || expectedCopy.volume != info.VolumeSerialNumber.ToString())
                            throw new IOException("Published destination contents changed. Source cleanup was refused.");
                        if (!node.Directory)
                            using (FileStream original = new FileStream(DuplicateReadHandle(node.Handle), FileAccess.Read))
                            using (FileStream output = new FileStream(DuplicateReadHandle(guard), FileAccess.Read))
                            using (System.Security.Cryptography.SHA256 first = System.Security.Cryptography.SHA256.Create())
                            using (System.Security.Cryptography.SHA256 second = System.Security.Cryptography.SHA256.Create())
                            {
                                original.Position = 0;
                                if (!System.Linq.Enumerable.SequenceEqual(first.ComputeHash(original), second.ComputeHash(output)))
                                    throw new IOException("Published destination bytes changed. Source cleanup was refused.");
                            }
                        else
                        {
                            HashSet<string> expectedNames = expectedChildren.ContainsKey(node.Relative)
                                ? expectedChildren[node.Relative] : new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                            HashSet<string> actual = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                            foreach (string child in Directory.EnumerateFileSystemEntries(copiedPath))
                                actual.Add(Path.GetFileName(child));
                            if (!actual.SetEquals(expectedNames))
                                throw new IOException("Published destination folder contents changed. Source cleanup was refused.");
                        }
                    }
                    // Only opened, identity-bound source entries are retired; new children
                    // make directory removal fail rather than being recursively deleted.
                    Console.WriteLine(Json.Serialize(new { progress = true, phase = "finishing-move", bytes = copied, totalBytes = total }));
                    for (int index = nodes.Count - 1; index >= 0; index--)
                    {
                        IntPtr disposition = System.Runtime.InteropServices.Marshal.AllocHGlobal(1);
                        try
                        {
                            System.Runtime.InteropServices.Marshal.WriteByte(disposition, 1);
                            Check(SetFileInformationByHandle(nodes[index].Handle, 4, disposition, 1), "Unable to finish source cleanup; verified destination is retained");
                        }
                        finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(disposition); }
                        nodes[index].Handle.Dispose();
                    }
                }
                finally { foreach (SafeFileHandle guard in destinationLocks) guard.Dispose(); }
            }
            Console.WriteLine(Json.Serialize(new { success = true, path = final, bytes = copied, entries = nodes.Count, moved = moving }));
            return 0;
        }
        catch (Exception error)
        {
            string cleanup = "";
            for (int index = stageLocks.Count - 1; index >= 0; index--) stageLocks[index].Dispose();
            stageLocks.Clear();
            // Only paths this operation created, never recursive deletion of a destination.
            if (!published)
            {
                for (int index = createdFiles.Count - 1; index >= 0; index--)
                    try { RemoveCreated(createdFiles[index]); } catch (Exception failure) { cleanup += " " + failure.Message; }
                for (int index = createdDirectories.Count - 1; index >= 0; index--)
                    try { RemoveCreated(createdDirectories[index]); } catch (Exception failure) { cleanup += " " + failure.Message; }
            }
            Console.WriteLine(Json.Serialize(new {
                error = error.Message + (published && moving ? " Verified copy remains at " + finalPath + "; source cleanup may be incomplete. Inspect both locations before retrying." : "") + (cleanup.Length == 0 ? "" : " Staging cleanup failed at " + stage + ":" + cleanup),
                outcomeUncertain = published && moving,
                cancelled = error is OperationCanceledException, stage = cleanup.Length == 0 ? null : stage
            }));
            return 1;
        }
        finally
        {
            for (int index = locks.Count - 1; index >= 0; index--) locks[index].Dispose();
            if (identity != null) identity.Dispose();
        }
    }
}
