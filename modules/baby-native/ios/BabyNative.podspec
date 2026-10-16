Pod::Spec.new do |s|
  s.name           = 'BabyNative'
  s.version        = '1.0.0'
  s.summary        = 'Local network discovery, signaling and audio setup for the baby monitor'
  s.description    = 'Bonjour discovery + newline-delimited JSON over TCP, WebRTC audio session config, immersive mode'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  # Same WebRTC build that react-native-webrtc links, used to configure RTCAudioSession.
  s.dependency 'JitsiWebRTC'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
