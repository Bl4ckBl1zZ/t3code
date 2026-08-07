require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'T3TerminalNative'
  s.version = package['version']
  s.summary = 'Native terminal surface for T3 Code mobile.'
  s.description = 'Native terminal surface bridge used by the T3 Code React Native app.'
  s.homepage = 'https://t3tools.com'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'T3 Tools' => 'hello@t3tools.com' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  # Moved to native/libghostty so apps/swift-ios can link it without depending
  # on this app being present. The React Native iOS build is deprecated and no
  # pipeline runs it; this path is kept pointing at the new location so the pod
  # still resolves for anyone reproducing a legacy build.
  s.vendored_frameworks = '../../../../native/libghostty/GhosttyKit.xcframework'
  s.frameworks = 'IOSurface', 'Metal', 'MetalKit', 'QuartzCore', 'UIKit'
  s.libraries = 'c++', 'z'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
