Set-StrictMode -Version Latest

function Get-ReleaseSourceSnapshot {
    param([string]$SourceRoot)

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        return $null
    }
    $rawRelativePaths = @(
        & $git.Source -C $SourceRoot -c core.quotePath=false `
            ls-files --cached --others --exclude-standard 2>$null
    )
    if ($LASTEXITCODE -ne 0 -or $rawRelativePaths.Count -eq 0) {
        return $null
    }

    $relativePathSet = [System.Collections.Generic.SortedSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($rawRelativePath in $rawRelativePaths) {
        if (-not [string]::IsNullOrEmpty([string]$rawRelativePath)) {
            [void]$relativePathSet.Add([string]$rawRelativePath)
        }
    }
    $relativePaths = @($relativePathSet)
    if ($relativePaths.Count -eq 0) {
        return $null
    }

    $sourceRootFull = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd(
        [char[]]@('\', '/')
    )
    $sourceRootPrefix = $sourceRootFull + [System.IO.Path]::DirectorySeparatorChar
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $buffer = New-Object byte[] (1024 * 1024)
    $fileCount = 0

    try {
        foreach ($relativePathValue in $relativePaths) {
            $relativePath = [string]$relativePathValue
            if ([string]::IsNullOrEmpty($relativePath)) {
                continue
            }

            $fullPath = [System.IO.Path]::GetFullPath(
                (Join-Path $SourceRoot $relativePath)
            )
            if (-not $fullPath.StartsWith(
                    $sourceRootPrefix,
                    [System.StringComparison]::OrdinalIgnoreCase
                )) {
                return $null
            }

            $normalizedPath = $relativePath.Replace('\', '/')
            if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
                $fileInfo = Get-Item -LiteralPath $fullPath -ErrorAction Stop
                $header = $utf8.GetBytes(
                    "file`0$normalizedPath`0$($fileInfo.Length)`0"
                )
                [void]$hasher.TransformBlock(
                    $header,
                    0,
                    $header.Length,
                    $header,
                    0
                )

                $stream = [System.IO.File]::OpenRead($fullPath)
                try {
                    while (($bytesRead = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        [void]$hasher.TransformBlock(
                            $buffer,
                            0,
                            $bytesRead,
                            $buffer,
                            0
                        )
                    }
                } finally {
                    $stream.Dispose()
                }
                $fileCount = $fileCount + 1
            } else {
                $header = $utf8.GetBytes("missing`0$normalizedPath`0")
                [void]$hasher.TransformBlock(
                    $header,
                    0,
                    $header.Length,
                    $header,
                    0
                )
            }

            $terminator = [byte[]]@(0)
            [void]$hasher.TransformBlock(
                $terminator,
                0,
                $terminator.Length,
                $terminator,
                0
            )
        }

        [void]$hasher.TransformFinalBlock([byte[]]@(), 0, 0)
        $snapshotSha256 = ([System.BitConverter]::ToString($hasher.Hash)).Replace(
            '-',
            ''
        ).ToLowerInvariant()
        return [pscustomobject]([ordered]@{
            sha256 = $snapshotSha256
            fileCount = $fileCount
            algorithm = 'sha256(file-nul-path-nul-size-nul-content-nul)/git-ls-files-cached-others-exclude-standard/ordinal-sort-unique/v2'
        })
    } catch {
        return $null
    } finally {
        $hasher.Dispose()
    }
}
