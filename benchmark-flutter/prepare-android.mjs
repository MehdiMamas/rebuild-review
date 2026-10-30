// Run after `flutter create`: the generated release manifest has no INTERNET permission and blocks plain HTTP.
import fs from 'node:fs';
const f = 'android/app/src/main/AndroidManifest.xml';
let s = fs.readFileSync(f, 'utf8');
if (!s.includes('android.permission.INTERNET')) s = s.replace('<application', '<uses-permission android:name="android.permission.INTERNET"/>\n    <application');
if (!s.includes('usesCleartextTraffic')) s = s.replace('<application', '<application android:usesCleartextTraffic="true"');
fs.writeFileSync(f, s);
