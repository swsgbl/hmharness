Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, 38872)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if ($win -eq $null) { Write-Output 'WINDOW NOT FOUND'; exit 1 }
Write-Output ('Window: ' + $win.Current.Name)

# Find the content pane (tabbrowser-tabpanels / document)
$allCond = [System.Windows.Automation.Condition]::TrueCondition
$desc = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $allCond)
Write-Output ('Total descendants: ' + $desc.Count)

foreach ($el in $desc) {
    $c = $el.Current
    $rect = $c.BoundingRectangle
    $line = '{0} | {1} | {2} | x={3} y={4} w={5} h={6}' -f $c.ControlType.ProgrammaticName, $c.Name, $c.AutomationId, $rect.X, $rect.Y, $rect.Width, $rect.Height
    Write-Output $line
}
