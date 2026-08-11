[CmdletBinding()]
param(
    [int]$DurationMs = 180000,
    [int]$FrequencyHz = 440,
    [int]$SampleRate = 48000,
    [double]$Amplitude = 0.2
)

$ErrorActionPreference = "Stop"

$DurationMs = [Math]::Max(1000, $DurationMs)
$FrequencyHz = [Math]::Max(20, [Math]::Min(20000, $FrequencyHz))
$SampleRate = [Math]::Max(8000, [Math]::Min(192000, $SampleRate))
$Amplitude = [Math]::Max(0.01, [Math]::Min(0.8, $Amplitude))

$channels = 2
$bitsPerSample = 16
$secondsPerLoop = 1
$sampleCount = $SampleRate * $secondsPerLoop
$blockAlign = $channels * ($bitsPerSample / 8)
$byteRate = $SampleRate * $blockAlign
$dataLength = $sampleCount * $blockAlign

$stream = [System.IO.MemoryStream]::new(44 + $dataLength)
$writer = [System.IO.BinaryWriter]::new($stream, [System.Text.Encoding]::ASCII, $true)
try {
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("RIFF"))
    $writer.Write([int](36 + $dataLength))
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("WAVE"))
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("fmt "))
    $writer.Write([int]16)
    $writer.Write([int16]1)
    $writer.Write([int16]$channels)
    $writer.Write([int]$SampleRate)
    $writer.Write([int]$byteRate)
    $writer.Write([int16]$blockAlign)
    $writer.Write([int16]$bitsPerSample)
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("data"))
    $writer.Write([int]$dataLength)

    $peak = [double][int16]::MaxValue * $Amplitude
    for ($sample = 0; $sample -lt $sampleCount; $sample++) {
        $angle = 2.0 * [Math]::PI * $FrequencyHz * $sample / $SampleRate
        $value = [int16]([Math]::Round([Math]::Sin($angle) * $peak))
        $writer.Write($value)
        $writer.Write($value)
    }
    $writer.Flush()
    $stream.Position = 0

    $player = [System.Media.SoundPlayer]::new($stream)
    $player.Load()
    $player.PlayLooping()
    Write-Output "AUDIO_TEST_TONE_READY frequencyHz=$FrequencyHz sampleRate=$SampleRate channels=$channels"
    Start-Sleep -Milliseconds $DurationMs
    $player.Stop()
} finally {
    $writer.Dispose()
    $stream.Dispose()
}
