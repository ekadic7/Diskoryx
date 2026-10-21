using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

internal static partial class Program
{
    public sealed class RestoreRequest
    {
        public string target { get; set; }
        public string destination { get; set; }
        public string metadata { get; set; }
        public Entry[] entries { get; set; }
        public Entry[] destinationEntries { get; set; }
        public Entry[] metadataEntries { get; set; }
    }

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(uint eventId, uint flags, string first, string second);

    private static SafeFileHandle PinMoveChain(string target, Entry[] entries, List<SafeFileHandle> locks)
    {
        string current = Path.GetPathRoot(target);
        string[] components = target.Substring(current.Length).Split('\\');
        if (entries == null || components.Length != entries.Length)
            throw new InvalidOperationException("Incomplete restore identity chain.");
        locks.Add(Open(current, false, null));
        SafeFileHandle leaf = null;
        for (int index = 0; index < components.Length; index++)
        {
            current = Path.Combine(current, components[index]);
            if (entries[index] == null || !String.Equals(entries[index].path, current, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Invalid restore identity chain.");
            leaf = Open(current, index == components.Length - 1, entries[index]);
            locks.Add(leaf);
        }
        return leaf;
    }

    private static int RestoreMain()
    {
        Console.InputEncoding = new System.Text.UTF8Encoding(false);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        List<SafeFileHandle> locks = new List<SafeFileHandle>();
        WindowsImpersonationContext identity = null;
        bool moved = false;
        try
        {
            string line = Console.ReadLine();
            if (line == null || line.Length > 262144) throw new IOException("Invalid restore request.");
            RestoreRequest request = Json.Deserialize<RestoreRequest>(line);
            string target = Normalize(request.target);
            string metadata = Normalize(request.metadata);
            string destination = Normalize(request.destination);
            identity = UseStandardRenameRights();
            string sid;
            using (WindowsIdentity user = WindowsIdentity.GetCurrent()) sid = user.User.Value;
            string bin = Path.Combine(Path.GetPathRoot(target), "$Recycle.Bin", sid) + "\\";
            if (!String.Equals(Path.GetPathRoot(target), Path.GetPathRoot(destination), StringComparison.OrdinalIgnoreCase)
                || !String.Equals(Path.GetDirectoryName(target) + "\\", bin, StringComparison.OrdinalIgnoreCase)
                || !String.Equals(Path.GetDirectoryName(metadata) + "\\", bin, StringComparison.OrdinalIgnoreCase)
                || !Path.GetFileName(target).StartsWith("$R", StringComparison.OrdinalIgnoreCase)
                || !String.Equals(Path.GetFileName(metadata), "$I" + Path.GetFileName(target).Substring(2), StringComparison.OrdinalIgnoreCase)
                || destination.StartsWith(Path.Combine(Path.GetPathRoot(target), "$Recycle.Bin") + "\\", StringComparison.OrdinalIgnoreCase))
                throw new IOException("Restore requires one exact item from this user's bin on the original volume.");
            ValidateName(Path.GetFileName(destination));
            SafeFileHandle leaf = PinMoveChain(target, request.entries, locks);
            SafeFileHandle info = PinMoveChain(metadata, request.metadataEntries, locks);
            string parent = Path.GetDirectoryName(destination);
            PinChain(parent, request.destinationEntries, locks);
            if (File.Exists(destination) || Directory.Exists(destination)) throw new IOException("The original path is occupied. Restore never overwrites it.");
            Console.WriteLine(Json.Serialize(new { ready = true, renameUsesStandardRights = true }));
            if (Console.ReadLine() != "commit") return 0;
            Rename(leaf, destination);
            moved = true;
            string warning = null;
            IntPtr buffer = Marshal.AllocHGlobal(1);
            try
            {
                Marshal.WriteByte(buffer, 1);
                if (!SetFileInformationByHandle(info, 4, buffer, 1))
                    warning = "The item was restored, but its exact Recycle Bin metadata could not be removed (Windows error " + Marshal.GetLastWin32Error() + ").";
            }
            finally { Marshal.FreeHGlobal(buffer); }
            SHChangeNotify(0x08000000, 0, null, null);
            Console.WriteLine(Json.Serialize(new { success = true, warning = warning }));
            return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine(Json.Serialize(new { error = error.Message, restored = moved }));
            return 1;
        }
        finally
        {
            for (int index = locks.Count - 1; index >= 0; index--) locks[index].Dispose();
            if (identity != null) identity.Dispose();
        }
    }
}
