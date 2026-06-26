param(
    [string]$Title = "Game Capture E2E Source",
    [int]$Width = 1280,
    [int]$Height = 720
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = "Manual"
$form.Left = 80
$form.Top = 80
$form.Width = $Width
$form.Height = $Height
$form.MinimumSize = New-Object System.Drawing.Size(640, 360)
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 28, 32)

$label = New-Object System.Windows.Forms.Label
$label.Dock = [System.Windows.Forms.DockStyle]::Fill
$label.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$label.Font = New-Object System.Drawing.Font("Segoe UI", 32, [System.Drawing.FontStyle]::Bold)
$label.ForeColor = [System.Drawing.Color]::White
$label.BackColor = [System.Drawing.Color]::Transparent
$form.Controls.Add($label)

$tick = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
    $script:tick++
    $phase = $script:tick % 6
    $colors = @(
        [System.Drawing.Color]::FromArgb(24, 28, 32),
        [System.Drawing.Color]::FromArgb(36, 54, 66),
        [System.Drawing.Color]::FromArgb(58, 44, 70),
        [System.Drawing.Color]::FromArgb(68, 56, 32),
        [System.Drawing.Color]::FromArgb(38, 66, 50),
        [System.Drawing.Color]::FromArgb(32, 50, 74)
    )
    $form.BackColor = $colors[$phase]
    $label.Text = "$Title`r`nFrame $script:tick"
})

$form.Add_Shown({
    $timer.Start()
    $form.Activate()
})

$form.Add_FormClosed({
    $timer.Stop()
    $timer.Dispose()
})

[System.Windows.Forms.Application]::Run($form)
