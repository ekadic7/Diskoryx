using System;
using System.Diagnostics;
using System.Threading;

internal static class Program
{
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        Console.WriteLine("{\"pid\":" + Process.GetCurrentProcess().Id + "}");
        if (args.Length != 1) return 3;
        Console.Error.WriteLine("fixture scanner progress");
        if (args[0] == @"\\.\H:")
        {
            for (int i = 0; i < 32; i++) Console.Write((char)i);
            Console.Write("\"\\/<>&\u2028\u2029\u010d\u65e5\ud83d\ude42");
            Console.Error.Write("\0\t\r\n\"\\\u010d\ud83d\ude42");
            return 0;
        }
        if (args[0] == @"\\.\G:")
        {
            for (int i = 0; i < 20000; i++)
                Console.WriteLine("{\"index\":" + i + ",\"name\":\"\u010ditanje-\u65e5\u672c\u8a9e-\ud83d\ude42\"}");
            return 0;
        }
        if (args[0] == @"\\.\F:")
        {
            Process descendant = Process.Start(new ProcessStartInfo(
                Process.GetCurrentProcess().MainModule.FileName, @"\\.\D:")
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            });
            Console.WriteLine("{\"descendantPid\":" + descendant.Id + "}");
            while (true) Thread.Sleep(100);
        }
        if (args[0] == @"\\.\D:")
        {
            while (true) Thread.Sleep(100);
        }
        if (args[0] != @"\\.\C:") return 4;
        Console.WriteLine("{\"type\":\"summary\",\"elapsedMs\":1}");
        return 0;
    }
}
