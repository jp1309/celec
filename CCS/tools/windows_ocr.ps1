param(
    [Parameter(Mandatory = $true)]
    [string]$InputList
)

$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]

$asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1
}

function Await-Operation($operation, [type]$resultType) {
    $method = $script:asTaskMethods | Where-Object {
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $generic = $method.MakeGenericMethod($resultType)
    $task = $generic.Invoke($null, @($operation))
    $task.Wait() | Out-Null
    if ($task.Exception) {
        throw $task.Exception
    }
    return $task.Result
}

function Get-LineBox($line) {
    $left = [double]::PositiveInfinity
    $top = [double]::PositiveInfinity
    $right = 0.0
    $bottom = 0.0

    foreach ($word in $line.Words) {
        $rect = $word.BoundingRect
        $left = [Math]::Min($left, $rect.X)
        $top = [Math]::Min($top, $rect.Y)
        $right = [Math]::Max($right, $rect.X + $rect.Width)
        $bottom = [Math]::Max($bottom, $rect.Y + $rect.Height)
    }

    if ($left -eq [double]::PositiveInfinity) {
        $left = 0.0
        $top = 0.0
    }

    return @{
        x = [Math]::Round($left, 2)
        y = [Math]::Round($top, 2)
        w = [Math]::Round([Math]::Max(0.0, $right - $left), 2)
        h = [Math]::Round([Math]::Max(0.0, $bottom - $top), 2)
    }
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
    throw "Windows OCR engine is not available for the current user profile."
}

$results = New-Object System.Collections.Generic.List[object]
$paths = Get-Content -LiteralPath $InputList

foreach ($path in $paths) {
    if ([string]::IsNullOrWhiteSpace($path)) {
        continue
    }

    try {
        $resolvedPath = (Resolve-Path -LiteralPath $path).Path
        $file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolvedPath)) ([Windows.Storage.StorageFile])
        $stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $ocr = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

        $lines = @()
        foreach ($line in $ocr.Lines) {
            $box = Get-LineBox $line
            $lines += [pscustomobject]@{
                text = $line.Text
                x = $box.x
                y = $box.y
                w = $box.w
                h = $box.h
            }
        }

        $results.Add([pscustomobject]@{
            path = $resolvedPath
            ok = $true
            text = $ocr.Text
            lines = $lines
            error = ""
        }) | Out-Null
    }
    catch {
        $results.Add([pscustomobject]@{
            path = $path
            ok = $false
            text = ""
            lines = @()
            error = $_.Exception.Message
        }) | Out-Null
    }
}

$results | ConvertTo-Json -Depth 6 -Compress
