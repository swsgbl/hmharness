Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, 38872)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if ($win -eq $null) { Write-Output 'WINDOW NOT FOUND'; exit 1 }

# Walk with stack to print tree structure, marking documents
function Walk($el, $depth) {
    $c = $el.Current
    $rect = $c.BoundingRectangle
    $ctrl = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
    $name = $c.Name
    if ($name.Length -gt 60) { $name = $name.Substring(0,60) }
    $off = if ($c.IsOffscreen) { ' [OFF]' } else { '' }
    Write-Output ('{0}{1} | {2} | {3} | x={4} y={5}{6}' -f ('  ' * $depth), $ctrl, $name, $c.AutomationId, [int]$rect.X, [int]$rect.Y, $off)
    if ($depth -lt 4) {
        $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($ch in $children) { Walk $ch ($depth + 1) }
    }
}

Walk $win 0
