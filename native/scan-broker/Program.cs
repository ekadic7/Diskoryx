using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.IO.Pipes;
using Microsoft.Win32.SafeHandles;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;

internal static class Program
{
    private static readonly object State = new object();
    private static readonly object Output = new object();
    private static Process scanner;
    private static Thread worker;
    private static int activeId;
    private static bool cancelled;
    private static bool outputFailed;
    private static IntPtr lifetimeJob;
    private static TextReader commands;
    private static TextWriter responses;
    private static FileStream scannerImage;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientPid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int informationClass,
        out int information, int size, out int required);

    private static void RequireOrdinaryUser()
    {
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            int elevated, required;
            if (!GetTokenInformation(identity.Token, 20, out elevated, 4, out required))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to check application privileges.");
            if (elevated != 0 || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException("Start Diskoryx normally, not as administrator. Only the MFT scanner requests UAC.");
        }
    }

    private static int RunClient()
    {
        RequireOrdinaryUser();
        string executable = Process.GetCurrentProcess().MainModule.FileName;
        // Keep the approved worker image from being replaced during UAC/its lifetime.
        using (FileStream image = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            string name = "diskoryx-scan-" + Guid.NewGuid().ToString("N");
            PipeSecurity security = new PipeSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new PipeAccessRule(identity.User, PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                PipeAccessRights.ReadWrite, AccessControlType.Allow));
            using (NamedPipeServerStream pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security))
            {
                Process elevated = null;
                try
                {
                    // Begin listening before UAC; broker verifies this server's PID.
                    IAsyncResult connection = pipe.BeginWaitForConnection(null, null);
                    try
                    {
                        elevated = Process.Start(new ProcessStartInfo(executable,
                            "--pipe " + name + " --parent " + Process.GetCurrentProcess().Id)
                        {
                            UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden
                        });
                    }
                    catch (Win32Exception error)
                    {
                        if (error.NativeErrorCode != 1223) throw;
                        throw new InvalidOperationException("Administrator scan permission was cancelled. No scan was started. Choose Scan drive to try again.");
                    }
                    if (elevated == null) throw new InvalidOperationException("Windows did not return the scanner process.");
                    if (!connection.AsyncWaitHandle.WaitOne(15000))
                        throw new TimeoutException("The administrator scanner did not connect.");
                    pipe.EndWaitForConnection(connection);
                    uint clientPid;
                    if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientPid))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to verify the scanner process.");
                    if (clientPid != (uint)elevated.Id || elevated.HasExited)
                        throw new InvalidOperationException("Unexpected process connected to the scanner pipe.");
                    StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 65536, true);
                    StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true);
                    Thread input = new Thread(delegate()
                    {
                        try
                        {
                            string line;
                            while ((line = ReadRequest()) != null)
                            {
                                writer.WriteLine(line);
                                writer.Flush();
                            }
                        }
                        catch (Exception error) { Console.Error.WriteLine("Scanner command connection ended: " + error.Message); }
                        // Termination of this non-elevated bridge also terminates the
                        // broker via its retained parent handle and kill-on-close job.
                        Environment.Exit(0);
                    });
                    input.IsBackground = true;
                    input.Start();
                    string response;
                    while ((response = reader.ReadLine()) != null)
                    {
                        Console.WriteLine(response);
                        Console.Out.Flush();
                    }
                    throw new IOException("Administrator scanner connection closed. Start a new scan to reconnect.");
                }
                finally
                {
                    if (elevated != null) elevated.Dispose();
                }
            }
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverPid);

    private static NamedPipeClientStream Connect(string[] args)
    {
        if (args.Length == 0)
        {
            commands = Console.In;
            responses = Console.Out;
            return null;
        }
        int parentPid;
        if (args.Length != 4 || args[0] != "--pipe" || args[2] != "--parent"
            || !System.Text.RegularExpressions.Regex.IsMatch(args[1], @"^diskoryx-scan-[a-f0-9]{32}$")
            || !Int32.TryParse(args[3], out parentPid) || parentPid <= 0)
            throw new InvalidOperationException("Invalid scanner connection arguments.");
        // Acquire a process handle before connecting; retain it rather than
        // repeatedly looking up a PID that Windows could later reuse.
        Process parent = Process.GetProcessById(parentPid);
        try
        {
            IntPtr parentHandle = parent.Handle;
            NamedPipeClientStream pipe = new NamedPipeClientStream(".", args[1], PipeDirection.InOut,
                PipeOptions.Asynchronous, System.Security.Principal.TokenImpersonationLevel.Identification);
            try
            {
                pipe.Connect(10000);
                uint serverPid;
                if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out serverPid))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to verify scanner connection owner.");
                if (serverPid != (uint)parentPid || parent.HasExited)
                    throw new InvalidOperationException("Scanner connection does not belong to the expected application.");
                commands = new StreamReader(pipe, new UTF8Encoding(false, true), false, 4096, true);
                responses = new StreamWriter(pipe, new UTF8Encoding(false), 65536, true);
                Thread monitor = new Thread(delegate()
                {
                    parent.WaitForExit();
                    // OS closes our lifetime job even if another thread is blocked.
                    Environment.Exit(0);
                });
                monitor.IsBackground = true;
                monitor.Start();
                return pipe;
            }
            catch
            {
                pipe.Dispose();
                throw;
            }
        }
        catch
        {
            parent.Dispose();
            throw;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessTime, PerJobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass,
        ref ExtendedLimits information, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void ContainScannerLifetime()
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create scanner lifetime job.");
        bool assigned = false;
        try
        {
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to configure scanner lifetime job.");
            // Join before creating any child so containment has no post-launch race.
            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to contain the scanner broker.");
            assigned = true;
            // Non-inheritable handle deliberately lives until process exit. Windows
            // closes it even after forced termination, killing all job descendants.
            lifetimeJob = job;
        }
        finally
        {
            if (!assigned) CloseHandle(job);
        }
    }

    private sealed class Request
    {
        public string command { get; set; }
        public int id { get; set; }
        public string drive { get; set; }
    }

    private static bool Send(object message)
    {
        lock (Output)
        {
            if (outputFailed) return false;
            try
            {
                responses.WriteLine(new JavaScriptSerializer().Serialize(message));
                responses.Flush();
                return true;
            }
            catch (IOException error)
            {
                outputFailed = true;
                Console.Error.WriteLine("Scanner result connection failed: " + error.Message);
                return false;
            }
        }
    }

    private static string ReadRequest()
    {
        StringBuilder line = new StringBuilder();
        for (int value; (value = commands.Read()) != -1;)
        {
            if (value == '\n') return line.ToString().TrimEnd('\r');
            if (line.Length >= 1024) throw new InvalidOperationException("Scan request exceeds 1024 characters.");
            line.Append((char)value);
        }
        return line.Length == 0 ? null : line.ToString();
    }

    private static void Pump(StreamReader stream, string kind, int id)
    {
        byte[] bytes = new byte[65536];
        int count;
        // Forward raw bytes as base64. The scanner's binary stream must reach the
        // application unchanged, without a UTF-8 decode and JSON re-escape per frame.
        while ((count = stream.BaseStream.Read(bytes, 0, bytes.Length)) != 0)
        {
            if (!Send(new { type = kind, id = id, encoding = "base64", data = Convert.ToBase64String(bytes, 0, count) }))
                throw new IOException("Scanner result connection is closed.");
        }
    }

    private static void Complete(Process child, int id)
    {
        string failure = null;
        Thread stderr = new Thread(delegate()
        {
            try { Pump(child.StandardError, "stderr", id); }
            catch (Exception error)
            {
                failure = error.Message;
                lock (State) { Stop(); }
            }
        });
        stderr.Start();
        try { Pump(child.StandardOutput, "stdout", id); }
        catch (Exception error)
        {
            failure = error.Message;
            lock (State) { Stop(); }
        }
        child.WaitForExit();
        stderr.Join();
        lock (State)
        {
            Send(new { type = "exit", id = id, code = child.ExitCode, cancelled = cancelled, error = failure });
            scanner = null;
            child.Dispose();
            scannerImage.Dispose();
            scannerImage = null;
        }
    }

    // State must be held; only the scanner Process owned by this broker is stopped.
    private static void Stop()
    {
        if (scanner == null || scanner.HasExited) return;
        cancelled = true;
        try { scanner.Kill(); }
        catch (InvalidOperationException)
        {
            if (!scanner.HasExited) throw;
        }
    }

    private static void Handle(Request request)
    {
        if (request == null || request.id <= 0) throw new InvalidOperationException("A positive scan ID is required.");
        lock (State)
        {
            if (request.command == "cancel")
            {
                // An exit frame can already be in flight when the UI presses Stop.
                if (scanner == null && request.id == activeId) return;
                if (scanner == null || request.id != activeId)
                    throw new InvalidOperationException("No matching active scan.");
                Stop();
                return;
            }
            if (request.command != "scan") throw new InvalidOperationException("Unsupported scanner command.");
            if (scanner != null) throw new InvalidOperationException("A scan is already active.");
            if (request.drive == null || request.drive.Length != 1
                || Char.ToUpperInvariant(request.drive[0]) < 'A' || Char.ToUpperInvariant(request.drive[0]) > 'Z')
                throw new InvalidOperationException("Only a single local drive letter is accepted.");
            string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string[] scannerCandidates = new string[]
            {
                Path.Combine(baseDirectory, @"..\..\..\diskoryx-mft-scanner.exe"),
                Path.Combine(baseDirectory, @"..\..\mft-scanner\bin\diskoryx-mft-scanner.exe"),
                Path.Combine(baseDirectory, @"..\..\..\mft-scanner\target\release\diskoryx-mft-scanner.exe")
            };
            string executable = null;
            foreach (string candidate in scannerCandidates)
            {
                string fullPath = Path.GetFullPath(candidate);
                if (File.Exists(fullPath))
                {
                    executable = fullPath;
                    break;
                }
            }
            if (executable == null) throw new FileNotFoundException("The bundled MFT scanner is missing.");
            FileStream image = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read);
            try
            {
                using (SHA256 hash = SHA256.Create())
                {
                    string digest = BitConverter.ToString(hash.ComputeHash(image)).Replace("-", "");
                    if (!String.Equals(digest, ScannerIdentity.Sha256, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("The bundled MFT scanner does not match the approved local build.");
                }
            }
            catch { image.Dispose(); throw; }
            Process child = new Process();
            child.StartInfo = new ProcessStartInfo(executable, @"\\.\" + request.drive.ToUpperInvariant() + ":")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false)
            };
            try
            {
                child.Start();
            }
            catch
            {
                image.Dispose();
                child.Dispose();
                throw;
            }
            scanner = child;
            scannerImage = image;
            activeId = request.id;
            cancelled = false;
            Send(new { type = "started", id = activeId });
            worker = new Thread(delegate() { Complete(child, request.id); });
            worker.Start();
        }
    }

    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.SetOut(TextWriter.Synchronized(new StreamWriter(Console.OpenStandardOutput(),
            new UTF8Encoding(false), 65536) { AutoFlush = true }));
        int result = 0;
        NamedPipeClientStream connection = null;
        try
        {
            commands = Console.In;
            responses = Console.Out;
            if (args.Length == 1 && args[0] == "--check-ui")
            {
                RequireOrdinaryUser();
                Console.WriteLine("{\"standardUser\":true}");
                return 0;
            }
            if (args.Length == 1 && args[0] == "--client") return RunClient();
            ContainScannerLifetime();
            connection = Connect(args);
            Send(new { type = "ready", protocol = 3, childLifetimeContained = lifetimeJob != IntPtr.Zero });
            string line;
            while ((line = ReadRequest()) != null)
            {
                Request request = null;
                try
                {
                    request = new JavaScriptSerializer().Deserialize<Request>(line);
                    Handle(request);
                }
                catch (Exception error)
                {
                    Send(new { type = "error", id = request == null ? 0 : request.id, error = error.Message });
                }
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Scanner broker failed: " + error.Message);
            result = 1;
        }
        finally
        {
            lock (State) { Stop(); }
            if (worker != null) worker.Join();
            if (connection != null) connection.Dispose();
        }
        return result;
    }
}
