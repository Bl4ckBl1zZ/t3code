Pod::Spec.new do |s|
  s.name           = 'T3SwiftImport'
  s.version        = '1.0.0'
  s.summary        = 'Reads environments saved by the SwiftUI T3 Code client.'
  s.description    = 'One-time import of paired environments when this app replaces the SwiftUI client under the same bundle id.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '16.4',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.swift"
end
