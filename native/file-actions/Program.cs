using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.Principal;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static partial class Program
{
    private const uint ReadAttributes = 0x80;
    private const uint DeleteAccess = 0x10000;
    private const uint ShareRead = 1;
    private const uint ShareWrite = 2;
    private const uint ListDirectory = 1;
    private const uint OpenExisting = 3;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint BackupSemantics = 0x02000000;
    private const uint ReparseAttribute = 0x400;
    private const uint DirectoryAttribute = 0x10;
    private const uint TokenDuplicate = 2;
    private const uint TokenImpersonate = 4;
    private const uint TokenQuery = 8;
    private const uint QueryLimitedProcess = 0x1000;
    private const int TokenSessionId = 12;
    private const int TokenElevation = 20;
    private const int SecurityImpersonation = 2;
    private const int ImpersonationToken = 2;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    public sealed class Entry
    {
        public string path { get; set; }
        public string inode { get; set; }
        public string volume { get; set; }
        public bool isDirectory { get; set; }
    }

    public sealed class Request
    {
        public string root { get; set; }
        public string target { get; set; }
        public string newName { get; set; }
        public string mode { get; set; }
        public Entry[] entries { get; set; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RenameInformation
    {
        public uint ReplaceIfExists;
        public IntPtr RootDirectory;
        public uint FileNameLength;
        public char FileName;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder name, uint length, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass,
        IntPtr information, uint size);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int informationClass,
        IntPtr information, int size, out int required);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attributes,
        int impersonationLevel, int tokenType, out SafeFileHandle duplicate);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeFileHandle token);

    [DllImport("user32.dll")]
    private static extern IntPtr GetShellWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint processId);

    private static int TokenNumber(IntPtr token, int informationClass)
    {
        IntPtr buffer = Marshal.AllocHGlobal(4);
        try
        {
            int required;
            Check(GetTokenInformation(token, informationClass, buffer, 4, out required), "Unable to check file-action token");
            return Marshal.ReadInt32(buffer);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static WindowsImpersonationContext UseStandardRenameRights()
    {
        WindowsImpersonationContext context = null;
        try
        {
            SafeFileHandle processToken;
            Check(OpenProcessToken(GetCurrentProcess(), TokenQuery, out processToken), "Unable to inspect Rename process token");
            using (processToken)
            {
                if (TokenNumber(processToken.DangerousGetHandle(), TokenElevation) != 0)
                {
                    uint shellPid;
                    IntPtr window = GetShellWindow();
                    if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out shellPid) == 0)
                        throw new InvalidOperationException("Rename requires a standard desktop session; elevated fallback is not allowed.");
                    using (SafeFileHandle shellProcess = OpenProcess(QueryLimitedProcess, false, shellPid))
                    {
                        Check(!shellProcess.IsInvalid, "Unable to inspect the desktop session");
                        SafeFileHandle shellToken;
                        Check(OpenProcessToken(shellProcess.DangerousGetHandle(), TokenQuery | TokenDuplicate, out shellToken),
                            "Unable to obtain the standard desktop token");
                        using (shellToken)
                        using (WindowsIdentity caller = new WindowsIdentity(processToken.DangerousGetHandle()))
                        using (WindowsIdentity desktop = new WindowsIdentity(shellToken.DangerousGetHandle()))
                        {
                            if (caller.User == null || desktop.User == null || !caller.User.Equals(desktop.User)
                                || TokenNumber(processToken.DangerousGetHandle(), TokenSessionId) != TokenNumber(shellToken.DangerousGetHandle(), TokenSessionId)
                                || TokenNumber(shellToken.DangerousGetHandle(), TokenElevation) != 0
                                || new WindowsPrincipal(desktop).IsInRole(WindowsBuiltInRole.Administrator))
                                throw new InvalidOperationException("Rename requires the same user's non-administrator desktop session.");
                            SafeFileHandle duplicate;
                            Check(DuplicateTokenEx(shellToken.DangerousGetHandle(), TokenQuery | TokenDuplicate | TokenImpersonate,
                                IntPtr.Zero, SecurityImpersonation, ImpersonationToken, out duplicate),
                                "Unable to create a standard-user impersonation token");
                            using (duplicate)
                                context = WindowsIdentity.Impersonate(duplicate.DangerousGetHandle());
                        }
                    }
                }
            }
            using (WindowsIdentity effective = WindowsIdentity.GetCurrent())
            {
                if (TokenNumber(effective.Token, TokenElevation) != 0 || new WindowsPrincipal(effective).IsInRole(WindowsBuiltInRole.Administrator))
                    throw new InvalidOperationException("Rename refused: effective administrator rights are not allowed.");
            }
            return context;
        }
        catch
        {
            if (context != null) context.Dispose();
            throw;
        }
    }

    private static void Check(bool success, string operation)
    {
        if (!success)
        {
            int code = Marshal.GetLastWin32Error();
            throw new Win32Exception(code, operation + " (Windows error " + code + ": " + new Win32Exception(code).Message + ")");
        }
    }

    private static string Normalize(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || !System.Text.RegularExpressions.Regex.IsMatch(value, @"^[A-Za-z]:\\"))
            throw new InvalidOperationException("A local absolute drive path is required.");
        return Path.GetFullPath(value);
    }

    private static void ValidateName(string name)
    {
        if (String.IsNullOrWhiteSpace(name) || name.Length > 255 || name != name.Trim()
            || name.EndsWith(".") || name == "." || name == ".."
            || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
            || System.Text.RegularExpressions.Regex.IsMatch(name, @"^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(\.|$)",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            throw new InvalidOperationException("Invalid Windows filename.");
    }

    private static SafeFileHandle Open(string name, bool leaf, Entry expected)
    {
        // Attribute-only directory handles do not enforce the sharing lock.
        // Directory writes must stay shareable so Windows can move the child.
        SafeFileHandle handle = CreateFileW(@"\\?\" + name, ReadAttributes | (leaf ? DeleteAccess : ListDirectory),
            leaf ? ShareRead : ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
        try
        {
            Check(!handle.IsInvalid, "Unable to lock the selected item or an ancestor");
            FileInformation information;
            Check(GetFileInformationByHandle(handle, out information), "Unable to read item identity");
            if ((information.Attributes & ReparseAttribute) != 0)
                throw new InvalidOperationException("Links and junctions are not allowed.");
            bool directory = (information.Attributes & DirectoryAttribute) != 0;
            if ((!leaf && !directory) || (expected != null && expected.isDirectory != directory))
                throw new InvalidOperationException("The selected item type changed.");
            string inode = (((ulong)information.FileIndexHigh << 32) | information.FileIndexLow).ToString(CultureInfo.InvariantCulture);
            if (expected != null && (expected.inode != inode
                || expected.volume != information.VolumeSerialNumber.ToString(CultureInfo.InvariantCulture)))
                throw new InvalidOperationException("The selected item or an ancestor changed.");
            StringBuilder resolved = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(handle, resolved, (uint)resolved.Capacity, 0);
            Check(length != 0, "Unable to resolve the locked item");
            if (length >= resolved.Capacity || !String.Equals(resolved.ToString(), @"\\?\" + name, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The locked item resolves through a redirected path.");
            return handle;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static void Rename(SafeFileHandle target, string destination)
    {
        byte[] bytes = Encoding.Unicode.GetBytes(@"\\?\" + destination);
        int offset = (int)Marshal.OffsetOf(typeof(RenameInformation), "FileName");
        int size = Math.Max(Marshal.SizeOf(typeof(RenameInformation)), offset + bytes.Length + 2);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
            Marshal.WriteInt32(buffer, (int)Marshal.OffsetOf(typeof(RenameInformation), "FileNameLength"), bytes.Length);
            Marshal.Copy(bytes, 0, IntPtr.Add(buffer, offset), bytes.Length);
            // ReplaceIfExists stays false; the kernel decides atomically if the name is occupied.
            Check(SetFileInformationByHandle(target, 3, buffer, (uint)size), "Windows refused the no-replace rename");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static int CreateFolderMain()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        List<SafeFileHandle> handles = new List<SafeFileHandle>();
        WindowsImpersonationContext identity = null;
        bool committed = false;
        try
        {
            string line = Console.ReadLine();
            if (line == null || line.Length > 131072) throw new InvalidOperationException("Invalid Create folder request.");
            Request request = Json.Deserialize<Request>(line);
            string root = Normalize(request.root);
            string parent = Normalize(request.target);
            ValidateName(request.newName);
            identity = UseStandardRenameRights();
            string prefix = root.TrimEnd('\\') + "\\";
            if (!String.Equals(parent, root, StringComparison.OrdinalIgnoreCase)
                && !parent.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The destination folder is outside the current scanned location.");

            string current = Path.GetPathRoot(parent);
            string[] components = parent.Substring(current.Length).Split('\\');
            if (request.entries == null || request.entries.Length != components.Length)
                throw new InvalidOperationException("Incomplete destination folder identity chain.");
            handles.Add(Open(current, false, null));
            for (int index = 0; index < components.Length; index++)
            {
                current = Path.Combine(current, components[index]);
                Entry expected = request.entries[index];
                if (expected == null || !String.Equals(current, expected.path, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Invalid destination folder identity chain.");
                handles.Add(Open(current, false, expected));
            }

            Console.WriteLine(Json.Serialize(new { ready = true, createFolderUsesStandardRights = true }));
            if (Console.ReadLine() != "commit") return 0;
            committed = true;
            string destination = Path.Combine(parent, request.newName);
            Check(CreateDirectoryW(@"\\?\" + destination, IntPtr.Zero), "Unable to create the new folder without replacing an existing item");
            Console.WriteLine(Json.Serialize(new { success = true, path = destination }));
            return 0;
        }
        catch (Exception error)
        {
            Win32Exception windowsError = error as Win32Exception;
            string message = error.Message;
            if (committed && windowsError != null && windowsError.NativeErrorCode == 183)
                message = "An item with that name already exists. Nothing was replaced.";
            else if (windowsError != null && windowsError.NativeErrorCode == 5)
                message = "Create folder requires standard-user access. Protected locations are refused; no elevated fallback is used. " + message;
            Console.WriteLine(Json.Serialize(new { error = message, outcomeUncertain = false }));
            return 1;
        }
        finally
        {
            for (int index = handles.Count - 1; index >= 0; index--) handles[index].Dispose();
            if (identity != null) identity.Dispose();
        }
    }

    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--copy") return CopyMain();
        if (args.Length == 1 && args[0] == "--restore") return RestoreMain();
        if (args.Length == 1 && args[0] == "--create-folder") return CreateFolderMain();
        if (args.Length == 1 && args[0] == "--user-sid")
        {
            using (WindowsImpersonationContext normal = UseStandardRenameRights())
            using (WindowsIdentity user = WindowsIdentity.GetCurrent())
                Console.WriteLine(user.User.Value);
            return 0;
        }
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        List<SafeFileHandle> handles = new List<SafeFileHandle>();
        WindowsImpersonationContext renameIdentity = null;
        bool standardRename = false;
        try
        {
            string line = Console.ReadLine();
            if (line == null || line.Length > 131072) throw new InvalidOperationException("Invalid rename request.");
            Request request = Json.Deserialize<Request>(line);
            string root = Normalize(request.root);
            string target = Normalize(request.target);
            bool recycleGuard = request.mode == "recycle-guard";
            if (!recycleGuard && request.mode != "rename")
                throw new InvalidOperationException("Unsupported file-action mode.");
            standardRename = !recycleGuard;
            if (!recycleGuard) ValidateName(request.newName);
            // Impersonate before opening any filesystem handle; existing elevated handles
            // would retain their access even after changing the effective identity.
            if (!recycleGuard) renameIdentity = UseStandardRenameRights();
            string prefix = root.TrimEnd('\\') + "\\";
            if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || target.Length <= prefix.Length)
                throw new InvalidOperationException("The selected item is outside the scanned folder.");
            string current = Path.GetPathRoot(target);
            string[] components = target.Substring(current.Length).Split('\\');
            if (request.entries == null || request.entries.Length != components.Length)
                throw new InvalidOperationException("Incomplete identity chain.");
            handles.Add(Open(current, false, null));
            for (int index = 0; index < components.Length; index++)
            {
                current = Path.Combine(current, components[index]);
                Entry expected = request.entries[index];
                if (expected == null || !String.Equals(current, expected.path, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Invalid identity chain.");
                handles.Add(Open(current, index == components.Length - 1, expected));
            }
            if (recycleGuard)
            {
                // Shell recycling must be allowed to rename/delete the leaf; only ancestors stay pinned.
                handles[handles.Count - 1].Dispose();
                handles.RemoveAt(handles.Count - 1);
            }
            Console.WriteLine(Json.Serialize(new { ready = true, renameUsesStandardRights = !recycleGuard }));
            if (Console.ReadLine() != (recycleGuard ? "release" : "commit")) return 0;
            if (!recycleGuard)
                Rename(handles[handles.Count - 1], Path.Combine(Path.GetDirectoryName(target), request.newName));
            Console.WriteLine(Json.Serialize(new { success = true }));
            return 0;
        }
        catch (Exception error)
        {
            if (renameIdentity != null)
            {
                for (int index = handles.Count - 1; index >= 0; index--) handles[index].Dispose();
                handles.Clear();
                renameIdentity.Dispose();
                renameIdentity = null;
            }
            Win32Exception windowsError = error as Win32Exception;
            string message = error.Message;
            if (standardRename && windowsError != null && windowsError.NativeErrorCode == 5)
                message = "Rename requires standard-user access. Protected items are refused; no elevated fallback is used. " + message;
            Console.WriteLine(Json.Serialize(new { error = message }));
            return 1;
        }
        finally
        {
            for (int index = handles.Count - 1; index >= 0; index--) handles[index].Dispose();
            if (renameIdentity != null) renameIdentity.Dispose();
        }
    }
}
