# generate hmharness icon: blue-to-green gradient square + white "h" + rounded corners
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Drawing.Drawing2D

$sizes = @(64, 128, 256)
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  # rounded rect path
  $r = [int]($size * 0.22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r*2, $r*2, 180, 90)
  $path.AddArc($size-$r*2, 0, $r*2, $r*2, 270, 90)
  $path.AddArc($size-$r*2, $size-$r*2, $r*2, $r*2, 0, 90)
  $path.AddArc(0, $size-$r*2, $r*2, $r*2, 90, 90)
  $path.CloseFigure()

  # gradient fill
  $c1 = [System.Drawing.Color]::FromArgb(138, 180, 248)  # 8ab4f8
  $c2 = [System.Drawing.Color]::FromArgb(52, 168, 83)    # 34a853
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    $c1, $c2
  )
  $g.FillPath($brush, $path)

  # "h" letter
  $fontSize = [int]($size * 0.55)
  $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, [float]($size*0.02), $size, $size)
  $g.DrawString('h', $font, $textBrush, $rect, $sf)

  $outPath = "G:\hmharness\.audit\hmharness-icon-$size.png"
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "saved: $outPath ($size x $size)"
}
Write-Host 'done'
