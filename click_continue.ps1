Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    public const uint LEFTDOWN = 0x02;
    public const uint LEFTUP = 0x04;
    public static void Click() {
        mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }
}
"@

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, 38872)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if ($win -eq $null) { Write-Output 'WINDOW NOT FOUND'; exit 1 }
Write-Output ('[1] Window found: ' + $win.Current.Name)

# --- Check radio selection state ---
$idCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'id_channel_0')
$radio0 = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $idCond)
if ($radio0 -ne $null) {
    $sel = $radio0.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern])
    Write-Output ('[2] Radio id_channel_0 (On this website) IsSelected = ' + $sel.Current.IsSelected)
} else {
    Write-Output '[2] Radio id_channel_0 NOT FOUND'
}

# --- Click blank area to focus window (blank page background near heading) ---
[Win32]::SetCursorPos(700, 280) | Out-Null
Start-Sleep -Milliseconds 150
[Win32]::Click()
Start-Sleep -Milliseconds 400
Write-Output '[3] Clicked blank area (700,280) to focus window'

# --- Find and invoke the Continue button ---
$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Continue')
$btn = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
if ($btn -eq $null) { Write-Output 'CONTINUE BUTTON NOT FOUND'; exit 1 }
$r = $btn.Current.BoundingRectangle
Write-Output ('[4] Continue button at x=' + [int]$r.X + ' y=' + [int]$r.Y + ' w=' + [int]$r.Width + ' h=' + [int]$r.Height)
$inv = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern])
$inv.Invoke()
Write-Output '[5] Invoked Continue'

# --- Wait 3 seconds ---
Start-Sleep -Seconds 3
Write-Output '[6] Waited 3 seconds'

# --- Read URL bar ---
$urlCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'urlbar-input')
$urlbar = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $urlCond)
if ($urlbar -eq $null) { Write-Output 'URLBAR NOT FOUND'; exit 1 }
$textContent = $urlbar.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($t in $textContent) {
    $c = $t.Current
    if ($c.Name -match '^[a-z]+://|^[a-z0-9.-]+\.[a-z]{2,}') {
        Write-Output ('[7] URL BAR: ' + $c.Name)
    }
}
# Also read window title as corroboration
$winFresh = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
Write-Output ('[8] Window title now: ' + $winFresh.Current.Name)
