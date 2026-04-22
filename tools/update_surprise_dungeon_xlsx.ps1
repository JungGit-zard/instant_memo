param(
    [Parameter(Mandatory = $true)]
    [string]$InputPath,
    [string]$OutputPath = $InputPath
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-EntryText {
    param(
        [System.IO.Compression.ZipArchive]$Zip,
        [string]$EntryName
    )

    $entry = $Zip.GetEntry($EntryName)
    if ($null -eq $entry) {
        throw "Missing zip entry: $EntryName"
    }

    $reader = [System.IO.StreamReader]::new($entry.Open())
    try {
        return $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
    }
}

function Save-Utf8Xml {
    param(
        [xml]$Xml,
        [string]$Path
    )

    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $settings.Indent = $false
    $writer = [System.Xml.XmlWriter]::Create($Path, $settings)
    try {
        $Xml.Save($writer)
    }
    finally {
        $writer.Dispose()
    }
}

function Read-Utf8TextFile {
    param([string]$Path)
    $reader = [System.IO.StreamReader]::new($Path, [System.Text.Encoding]::UTF8, $true)
    try {
        return $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
    }
}

function Get-SharedStringText {
    param($SiNode)
    if ($SiNode.t) {
        return [string]$SiNode.t
    }

    $parts = @()
    foreach ($run in $SiNode.r) {
        if ($run.t) {
            $parts += [string]$run.t
        }
    }
    return ($parts -join '')
}

function Get-OrAddSharedStringIndex {
    param(
        [xml]$SharedXml,
        [System.Collections.Generic.Dictionary[string,int]]$Lookup,
        [string]$Value
    )

    if ($Lookup.ContainsKey($Value)) {
        return $Lookup[$Value]
    }

    $nsUri = $SharedXml.DocumentElement.NamespaceURI
    $si = $SharedXml.CreateElement('si', $nsUri)
    $t = $SharedXml.CreateElement('t', $nsUri)
    $t.InnerText = $Value
    [void]$si.AppendChild($t)
    [void]$SharedXml.sst.AppendChild($si)

    $index = $SharedXml.sst.si.Count - 1
    $Lookup[$Value] = $index
    return $index
}

function Get-CellColumn {
    param([string]$CellRef)
    return ($CellRef -replace '\d', '')
}

function Set-CellRefRow {
    param(
        [string]$CellRef,
        [int]$NewRow
    )
    $col = Get-CellColumn $CellRef
    return "$col$NewRow"
}

function Get-CellValue {
    param(
        $Cell,
        [string[]]$SharedStrings
    )

    if ($null -eq $Cell) {
        return ''
    }

    if ($Cell.t -eq 's') {
        return $SharedStrings[[int]$Cell.v]
    }

    if ($Cell.t -eq 'inlineStr') {
        return [string]$Cell.is.t
    }

    return [string]$Cell.v
}

function Update-RowRefs {
    param(
        $RowNode,
        [int]$NewRow
    )

    $RowNode.SetAttribute('r', [string]$NewRow)
    foreach ($cell in $RowNode.SelectNodes("./*[local-name()='c']")) {
        $cell.SetAttribute('r', (Set-CellRefRow -CellRef $cell.GetAttribute('r') -NewRow $NewRow))
    }
}

function Set-CellToSharedString {
    param(
        $Cell,
        [int]$SharedStringIndex
    )

    $Cell.RemoveAttribute('t')
    $Cell.SetAttribute('t', 's')

    $vNode = $Cell.SelectSingleNode("./*[local-name()='v']")
    if ($null -eq $vNode) {
        $vNode = $Cell.OwnerDocument.CreateElement('v', $Cell.OwnerDocument.DocumentElement.NamespaceURI)
        [void]$Cell.AppendChild($vNode)
    }
    $vNode.InnerText = [string]$SharedStringIndex

    $inlineNode = $Cell.SelectSingleNode("./*[local-name()='is']")
    if ($null -ne $inlineNode) {
        [void]$Cell.RemoveChild($inlineNode)
    }
}

function Get-NextCode {
    param([string]$CurrentCode)

    if ($CurrentCode -notmatch '^(.*_)(\d+)$') {
        throw "Cannot derive next code from: $CurrentCode"
    }

    $prefix = $Matches[1]
    $number = $Matches[2]
    $next = [int]$number + 1
    $formatted = $next.ToString().PadLeft($number.Length, '0')
    return "$prefix$formatted"
}

function Recompute-SharedStringCounts {
    param(
        [xml]$SharedXml,
        [xml[]]$SheetDocs
    )

    $total = 0
    foreach ($sheetXml in $SheetDocs) {
        $total += ($sheetXml.SelectNodes("//*[local-name()='c' and @t='s']").Count)
    }

    $SharedXml.sst.SetAttribute('count', [string]$total)
    $SharedXml.sst.SetAttribute('uniqueCount', [string]$SharedXml.sst.si.Count)
}

function Update-SheetDimension {
    param([xml]$SheetXml)

    $dimension = $SheetXml.SelectSingleNode("/*[local-name()='worksheet']/*[local-name()='dimension']")
    if ($null -eq $dimension) {
        return
    }

    $rows = $SheetXml.SelectNodes("/*[local-name()='worksheet']/*[local-name()='sheetData']/*[local-name()='row']")
    $lastRow = [int]($rows[$rows.Count - 1].GetAttribute('r'))
    $ref = $dimension.GetAttribute('ref')
    if ($ref -match '^([A-Z]+\d+):([A-Z]+)\d+$') {
        $dimension.SetAttribute('ref', "$($Matches[1]):$($Matches[2])$lastRow")
    }
}

$resolvedInput = (Resolve-Path $InputPath).Path
$resolvedOutput = if (Test-Path $OutputPath) { (Resolve-Path $OutputPath).Path } else { $OutputPath }
$workDir = Join-Path $env:TEMP ("surprise_dungeon_edit_" + [guid]::NewGuid().ToString('N'))
$extractDir = Join-Path $workDir 'unzipped'
$outputTemp = Join-Path $workDir 'output.xlsx'
$backupPath = if ($resolvedOutput -eq $resolvedInput) { "$resolvedInput.bak" } else { $null }

New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
[System.IO.Compression.ZipFile]::ExtractToDirectory($resolvedInput, $extractDir)

$sharedPath = Join-Path $extractDir 'xl\sharedStrings.xml'
[xml]$sharedXml = Read-Utf8TextFile $sharedPath
$sharedLookup = New-Object 'System.Collections.Generic.Dictionary[string,int]'
$sharedStrings = @()
for ($i = 0; $i -lt $sharedXml.sst.si.Count; $i += 1) {
    $text = Get-SharedStringText $sharedXml.sst.si[$i]
    $sharedStrings += $text
    if (-not $sharedLookup.ContainsKey($text)) {
        $sharedLookup[$text] = $i
    }
}

$sheet1Path = Join-Path $extractDir 'xl\worksheets\sheet1.xml'
[xml]$sheet1Xml = Get-Content -LiteralPath $sheet1Path -Raw
$sheet1Rows = $sheet1Xml.SelectNodes("/*[local-name()='worksheet']/*[local-name()='sheetData']/*[local-name()='row']")
$sheet1DataRows = @()
foreach ($row in $sheet1Rows) {
    $aCell = $row.SelectSingleNode("./*[local-name()='c' and starts-with(@r,'A')]")
    $aVal = Get-CellValue -Cell $aCell -SharedStrings $sharedStrings
    if ($aVal -and $aVal -ne '-') {
        $sheet1DataRows += $row
    }
}

$lastCode = Get-CellValue -Cell ($sheet1DataRows[-1].SelectSingleNode("./*[local-name()='c' and starts-with(@r,'A')]")) -SharedStrings $sharedStrings
$newCode = Get-NextCode $lastCode
$newCodeIndex = Get-OrAddSharedStringIndex -SharedXml $sharedXml -Lookup $sharedLookup -Value $newCode

$sheetDocs = New-Object System.Collections.Generic.List[xml]
foreach ($sheetFile in @('sheet1.xml', 'sheet2.xml', 'sheet3.xml')) {
    $sheetPath = Join-Path $extractDir ("xl\worksheets\" + $sheetFile)
    [xml]$sheetXml = Read-Utf8TextFile $sheetPath

    $rows = @($sheetXml.SelectNodes("/*[local-name()='worksheet']/*[local-name()='sheetData']/*[local-name()='row']"))
    $sentinelRow = $null
    $lastDataRow = $null
    $lastSheetCode = $null

    foreach ($row in $rows) {
        $aCell = $row.SelectSingleNode("./*[local-name()='c' and starts-with(@r,'A')]")
        $aVal = Get-CellValue -Cell $aCell -SharedStrings $sharedStrings
        if ($aVal -eq '-') {
            $sentinelRow = $row
            break
        }
        if ($aVal) {
            $lastDataRow = $row
            $lastSheetCode = $aVal
        }
    }

    if ($null -eq $sentinelRow -or $null -eq $lastDataRow) {
        throw "Could not find data/sentinel rows in $sheetFile"
    }

    if ($lastSheetCode -ne $lastCode) {
        throw "Last code mismatch in $sheetFile. Expected $lastCode but found $lastSheetCode"
    }

    $groupRows = New-Object System.Collections.Generic.List[object]
    $scanRow = $lastDataRow
    while ($null -ne $scanRow) {
        $aCell = $scanRow.SelectSingleNode("./*[local-name()='c' and starts-with(@r,'A')]")
        $aVal = Get-CellValue -Cell $aCell -SharedStrings $sharedStrings
        if ($aVal -ne $lastCode) {
            break
        }
        $groupRows.Insert(0, $scanRow)
        $prevSibling = $scanRow.PreviousSibling
        while ($null -ne $prevSibling -and $prevSibling.NodeType -ne [System.Xml.XmlNodeType]::Element) {
            $prevSibling = $prevSibling.PreviousSibling
        }
        $scanRow = $prevSibling
    }

    $groupCount = $groupRows.Count
    $insertRowNumber = [int]$sentinelRow.GetAttribute('r')

    foreach ($row in $rows) {
        $rowNumber = [int]$row.GetAttribute('r')
        if ($rowNumber -ge $insertRowNumber) {
            Update-RowRefs -RowNode $row -NewRow ($rowNumber + $groupCount)
        }
    }

    for ($i = 0; $i -lt $groupCount; $i += 1) {
        $clone = $sheetXml.ImportNode($groupRows[$i].CloneNode($true), $true)
        $newRowNumber = $insertRowNumber + $i
        Update-RowRefs -RowNode $clone -NewRow $newRowNumber
        $aCell = $clone.SelectSingleNode("./*[local-name()='c' and starts-with(@r,'A')]")
        Set-CellToSharedString -Cell $aCell -SharedStringIndex $newCodeIndex
        [void]$sentinelRow.ParentNode.InsertBefore($clone, $sentinelRow)
    }

    Update-SheetDimension -SheetXml $sheetXml
    Save-Utf8Xml -Xml $sheetXml -Path $sheetPath
    [void]$sheetDocs.Add($sheetXml)
}

Recompute-SharedStringCounts -SharedXml $sharedXml -SheetDocs @(
    $sheetDocs.ToArray()
)
Save-Utf8Xml -Xml $sharedXml -Path $sharedPath

if (Test-Path $outputTemp) {
    Remove-Item -LiteralPath $outputTemp -Force
}
[System.IO.Compression.ZipFile]::CreateFromDirectory($extractDir, $outputTemp)

if ($resolvedOutput -eq $resolvedInput) {
    Copy-Item -LiteralPath $resolvedInput -Destination $backupPath -Force
}

Copy-Item -LiteralPath $outputTemp -Destination $resolvedOutput -Force
Write-Output "Updated workbook saved to: $resolvedOutput"
if ($backupPath) {
    Write-Output "Backup created at: $backupPath"
}
