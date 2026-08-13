param([string]$OutputPath = "desktop/build/icon.png")

Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 512, 512
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$backgroundRect = New-Object System.Drawing.Rectangle 24, 24, 464, 464
$backgroundBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $backgroundRect,
  [System.Drawing.Color]::FromArgb(135, 167, 255),
  [System.Drawing.Color]::FromArgb(80, 109, 229),
  45
)
$backgroundPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 124
$diameter = $radius * 2
$backgroundPath.AddArc(24, 24, $diameter, $diameter, 180, 90)
$backgroundPath.AddArc(488 - $diameter, 24, $diameter, $diameter, 270, 90)
$backgroundPath.AddArc(488 - $diameter, 488 - $diameter, $diameter, $diameter, 0, 90)
$backgroundPath.AddArc(24, 488 - $diameter, $diameter, $diameter, 90, 90)
$backgroundPath.CloseFigure()
$graphics.FillPath($backgroundBrush, $backgroundPath)

$bubble = New-Object System.Drawing.Drawing2D.GraphicsPath
$bubble.AddBezier(132, 158, 132, 158, 238, 158, 300, 158)
$bubble.AddBezier(300, 158, 372, 158, 416, 200, 416, 260)
$bubble.AddBezier(416, 260, 416, 320, 372, 362, 300, 362)
$bubble.AddLine(300, 362, 248, 362)
$bubble.AddLine(248, 362, 158, 432)
$bubble.AddLine(158, 432, 182, 350)
$bubble.AddBezier(182, 350, 140, 331, 116, 300, 116, 260)
$bubble.AddBezier(116, 260, 116, 215, 142, 180, 182, 164)
$bubble.AddBezier(182, 164, 164, 160, 148, 158, 132, 158)
$bubble.CloseFigure()
$graphics.FillPath([System.Drawing.Brushes]::White, $bubble)
$dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(93, 125, 235))
$graphics.FillEllipse($dotBrush, 220, 236, 48, 48)
$graphics.FillEllipse($dotBrush, 302, 236, 48, 48)

$resolved = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($resolved)) | Out-Null
$bitmap.Save($resolved, [System.Drawing.Imaging.ImageFormat]::Png)

$dotBrush.Dispose()
$bubble.Dispose()
$backgroundPath.Dispose()
$backgroundBrush.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
