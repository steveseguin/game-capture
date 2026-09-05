param([Parameter(Mandatory = $true)][string]$StateDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class ThumbnailStallForm : Form {
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    public string StateDir;
    readonly System.Windows.Forms.Timer stallTimer = new System.Windows.Forms.Timer();
    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        ShowWindow(Handle, 5);
        File.WriteAllText(Path.Combine(StateDir, "ready"), "ready");
        stallTimer.Interval = 100;
        stallTimer.Tick += (sender, args) => {
            stallTimer.Stop();
            File.WriteAllText(Path.Combine(StateDir, "entered"), "Source message loop stalled");
            while (!File.Exists(Path.Combine(StateDir, "release"))) { Thread.Sleep(20); }
        };
        stallTimer.Start();
    }
}
'@
$form = New-Object ThumbnailStallForm
$form.StateDir = [IO.Path]::GetFullPath($StateDir)
$form.Text = 'Thumbnail Stall Fixture'
$form.Width = 640
$form.Height = 360
[System.Windows.Forms.Application]::Run($form)
