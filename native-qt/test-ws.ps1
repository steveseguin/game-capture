$url = "wss://wss.vdo.ninja:443"
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None

Write-Host "Connecting to $url..."
$connectTask = $ws.ConnectAsync([Uri]$url, $ct)
$connectTask.Wait(10000) | Out-Null

if ($ws.State -eq 'Open') {
    Write-Host "Connected! State: $($ws.State)"

    # Send seed request
    $msg = '{"request":"seed","streamID":"ps_test_12345"}'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
    $segment = New-Object System.ArraySegment[byte] $bytes
    Write-Host "Sending: $msg"
    $sendTask = $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct)
    $sendTask.Wait(5000) | Out-Null

    # Try to receive
    Write-Host "Waiting for response..."
    $buffer = New-Object byte[] 4096
    $segment = New-Object System.ArraySegment[byte] $buffer

    for ($i = 0; $i -lt 10; $i++) {
        $receiveTask = $ws.ReceiveAsync($segment, $ct)
        if ($receiveTask.Wait(1000)) {
            $result = $receiveTask.Result
            $received = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
            Write-Host "Received ($($result.MessageType)): $received"
        } else {
            Write-Host "No message after 1s, state=$($ws.State)"
        }
    }

    $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "Done", $ct).Wait(5000)
} else {
    Write-Host "Failed to connect: $($ws.State)"
}
