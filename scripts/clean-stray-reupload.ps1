# remove web-ext's stray bookkeeping file, rebuild clean upload xpi, copy to C-path
Remove-Item 'C:\Users\hongfu\.hmharness\extension-install\firefox\.amo-upload-uuid' -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\Users\hongfu\.hmharness\extension-live-2\firefox\.amo-upload-uuid' -Force -ErrorAction SilentlyContinue
Write-Host 'stray files removed'
Compress-Archive -Path 'C:\Users\hongfu\.hmharness\extension-install\firefox\*' -DestinationPath 'G:\hmharness\.audit\up2.zip' -Force
Move-Item 'G:\hmharness\.audit\up2.zip' 'C:\Users\hongfu\.hmharness\.audit\hmharness-listed-upload.xpi' -Force
Write-Host ("clean xpi: " + [Math]::Round((Get-Item 'C:\Users\hongfu\.hmharness\.audit\hmharness-listed-upload.xpi').Length / 1KB) + " KB")
