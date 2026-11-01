Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, 38872)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if ($win -eq $null) { Write-Output 'WINDOW NOT FOUND'; exit 1 }

# Find tabpanel-2 (active tab panel)
$idCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'tabpanel-2')
$panel = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $idCond)
if ($panel -eq $null) { Write-Output 'PANEL NOT FOUND'; exit 1 }
Write-Output 'Found tabpanel-2'

function Walk($el, $depth) {
    $c = $el.Current
    $rect = $c.BoundingRectangle
    $ctrl = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
    $name = $c.Name
    if ($name.Length -gt 90) { $name = $name.Substring(0,90) }
    $x = if ([double]::IsInfinity($rect.X)) { 'INF' } else { [int]$rect.X }
    $y = if ([double]::IsInfinity($rect.Y)) { 'INF' } else { [int]$rect.Y }
    $w = if ([double]::IsInfinity($rect.Width)) { 'INF' } else { [int]$rect.Width }
    $h = if ([double]::IsInfinity($rect.Height)) { 'INF' } else { [int]$rect.Height }
    $off = if ($c.IsOffscreen) { ' [OFF]' } else { '' }
    Write-Output ('{0}{1} | {2} | {3} | x={4} y={5} w={6} h={7}{8}' -f ('  ' * $depth), $ctrl, $name, $c.AutomationId, $x, $y, $w, $h, $off)
    if ($depth -lt 7) {
        $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($ch in $children) { Walk $ch ($depth + 1) }
    }
}

Walk $panel 0
