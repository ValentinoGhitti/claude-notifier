# Reproduce un archivo de audio (wav o mp3) de forma síncrona usando el
# objeto COM de Windows Media Player (WMPlayer.OCX). Se prefiere sobre
# System.Windows.Media.MediaPlayer porque ese último requiere un message
# loop de WPF (Dispatcher) para renderizar audio, que un script suelto de
# PowerShell no tiene por defecto — el audio nunca sonaba pese a no tirar
# errores. WMPlayer.OCX maneja su propio pump interno y es el patrón
# estandar para este caso de uso.
# Uso: powershell -NoProfile -NonInteractive -File play-audio.ps1 "C:\ruta\archivo.mp3"
param(
  [Parameter(Mandatory = $true)]
  [string]$SoundPath
)

$wmp = New-Object -ComObject WMPlayer.OCX.7
$wmp.settings.volume = 100
$wmp.URL = $SoundPath
$wmp.controls.play()

# playState 1 = stopped, 3 = playing. Esperamos a que arranque y luego a
# que termine, con un timeout total para no colgar el proceso si algo falla.
$waited = 0
while ($wmp.playState -ne 3 -and $waited -lt 30) {
  Start-Sleep -Milliseconds 100
  $waited++
}
$waited = 0
while ($wmp.playState -eq 3 -and $waited -lt 300) {
  Start-Sleep -Milliseconds 100
  $waited++
}

$wmp.controls.stop()
$wmp.close()
