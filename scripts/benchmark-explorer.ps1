param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Output,
    [ValidateRange(10, 600)][int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DiskoryxBenchmarkWindow {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
}
'@
$targetFile = Get-Item -LiteralPath $Target
if ($targetFile.PSIsContainer -or $targetFile.FullName -notlike 'C:\*') {
    throw 'Choose an existing ordinary file on C:.'
}
$stream = [IO.File]::OpenRead($targetFile.FullName)
$stream.Dispose()
$outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
if (Test-Path -LiteralPath $outputPath) { throw "Output already exists: $outputPath" }

$connection = New-Object System.Data.OleDb.OleDbConnection(
    "Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandText = "SELECT System.ItemPathDisplay FROM SystemIndex WHERE System.FileName = '$($targetFile.Name.Replace("'", "''"))'"
    $reader = $command.ExecuteReader()
    $indexed = $false
    while ($reader.Read()) {
        if ($reader.GetString(0) -ieq $targetFile.FullName) { $indexed = $true }
    }
    $reader.Close()
} finally {
    $connection.Dispose()
}

$shell = New-Object -ComObject Shell.Application
$before = @($shell.Windows() | ForEach-Object { $_.HWND })
$window = $null
try {
    Start-Process -FilePath "$env:WINDIR\explorer.exe" -ArgumentList '/n,C:\'
    for ($attempt = 0; $attempt -lt 40 -and -not $window; $attempt++) {
        Start-Sleep -Milliseconds 250
        foreach ($candidate in @($shell.Windows())) {
            if ($candidate.HWND -notin $before -and $candidate.LocationURL -eq 'file:///C:/') {
                $window = $candidate
                break
            }
        }
    }
    if (-not $window) { throw 'Could not identify a new, separate C: Explorer window.' }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.HWND)
    $searchCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty, ' Search Local Disk (C:)')
    $search = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $searchCondition)
    if (-not $search) { throw 'Could not identify the C: Explorer search field.' }
    [void][DiskoryxBenchmarkWindow]::SetForegroundWindow([IntPtr]$window.HWND)
    $search.SetFocus()
    if ([DiskoryxBenchmarkWindow]::GetForegroundWindow() -ne [IntPtr]$window.HWND) {
        throw 'Explorer is not the foreground window; refusing to send keyboard input.'
    }
    $value = $search.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $startedAt = [DateTimeOffset]::Now.ToString('o')
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $value.SetValue($targetFile.Name)
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    $found = $false
    $verifiedPath = $null
    $searchSubmitted = $false
    while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if ($window.LocationName -ne 'Local Disk (C:)') {
            $searchSubmitted = $true
            foreach ($item in @($window.Document.Folder.Items())) {
                if ($item.Path -ieq $targetFile.FullName) {
                    $rowCondition = [System.Windows.Automation.AndCondition]::new(
                        [System.Windows.Automation.PropertyCondition]::new(
                            [System.Windows.Automation.AutomationElement]::NameProperty, $item.Name),
                        [System.Windows.Automation.PropertyCondition]::new(
                            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                            [System.Windows.Automation.ControlType]::ListItem))
                    $row = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $rowCondition)
                    if ($row -and -not $row.Current.IsOffscreen) {
                        $verifiedPath = $item.Path
                        $found = $true
                        break
                    }
                }
            }
        }
        if ($found) { break }
        if (-not $searchSubmitted -and $watch.Elapsed.TotalSeconds -gt 5) {
            throw 'Explorer did not enter its search results view; this is not a timed-out search.'
        }
        Start-Sleep -Milliseconds 100
    }
    $watch.Stop()
    $result = [ordered]@{
        application = 'Windows File Explorer'
        startedAt = $startedAt
        scope = 'C:\'
        query = $targetFile.Name
        target = $targetFile.FullName
        indexedBefore = $indexed
        status = $(if ($found) { 'found' } else { 'not-found-within-time-limit' })
        verifiedPath = $verifiedPath
        elapsedMs = [math]::Round($watch.Elapsed.TotalMilliseconds, 1)
        timeoutSeconds = $TimeoutSeconds
        pollingIntervalMs = 100
        measurement = 'Typing query and Enter to visible filename row and exact Shell result path'
    }
    $json = $result | ConvertTo-Json
    [IO.File]::WriteAllText($outputPath, $json + [Environment]::NewLine)
    Write-Output $json
    if ($found) {
        $bounds = [DiskoryxBenchmarkWindow+RECT]::new()
        if (-not [DiskoryxBenchmarkWindow]::GetWindowRect([IntPtr]$window.HWND, [ref]$bounds)) {
            throw 'Cannot determine Explorer screenshot bounds.'
        }
        $bitmap = [Drawing.Bitmap]::new($bounds.Right - $bounds.Left, $bounds.Bottom - $bounds.Top)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $dc = $graphics.GetHdc()
            try {
                $captured = [DiskoryxBenchmarkWindow]::PrintWindow([IntPtr]$window.HWND, $dc, 2)
            } finally { $graphics.ReleaseHdc($dc) }
            if (-not $captured) { throw 'Explorer window capture failed.' }
            $r = $row.Current.BoundingRectangle
            $crop = [Drawing.Rectangle]::new(
                [int]($r.X - $bounds.Left), [int]($r.Y - $bounds.Top),
                [int]$r.Width, [int]$r.Height)
            $image = $bitmap.Clone($crop, $bitmap.PixelFormat)
            try { $image.Save("$outputPath.png", [Drawing.Imaging.ImageFormat]::Png) }
            finally { $image.Dispose() }
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally {
    if ($window) { $window.Quit() }
}
