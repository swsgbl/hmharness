Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, 38872)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if ($win -eq $null) { Write-Output 'WINDOW NOT FOUND'; exit 1 }

# Find the active document
$docCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '如何分发此版本 :: 开发者中心 :: Firefox 附加组件')
$doc = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $docCond)
if ($doc -eq $null) { Write-Output 'DOC NOT FOUND'; exit 1 }
Write-Output 'Found active document'

function Walk($el, $depth) {
    $c = $el.Current
    $rect = $c.BoundingRectangle
    $ctrl = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
    $name = $c.Name
    if ($name.Length -gt 80) { $name = $name.Substring(0,80) }
    $x = if ([double]::IsInfinity($rect.X)) { 'INF' } else { [int]$rect.X }
    $y = if ([double]::IsInfinity($rect.Y)) { 'INF' } else { [int]$rect.Y }
    $w = if ([double]::IsInfinity($rect.Width)) { 'INF' } else { [int]$rect.Width }
    $h = if ([double]::IsInfinity($rect.Height)) { 'INF' } else { [int]$rect.Height }
    $off = if ($c.IsOffscreen) { ' [OFF]' } else { '' }
    $sel = ''
    try { if ($el.GetSupportedProperties() -contains [System.Windows.Automation.AutomationElement]::TogglePatternProperty) {} } catch {}
    Write-Output ('{0}{1} | {2} | {3} | x={4} y={5} w={6} h={7}{8}' -f ('  ' * $depth), $ctrl, $name, $c.AutomationId, $x, $y, $w, $h, $off)
    if ($depth -lt 6) {
        $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($ch in $children) { Walk $ch ($depth + 1) }
    }
}

Walk $doc 0
