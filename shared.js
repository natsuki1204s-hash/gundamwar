// みんなの画像（Firebase の Firestore）の設定。空のままなら共有は使わず、画像は各自のブラウザだけに入る。
// 作り方と Firestore のルールは docs/みんなの画像_設定.md。
// apiKey は秘密の鍵ではない（Firebase の Web 用の識別子で、公開してよい物）。守りは Firestore のルールでかける。
window.GW_SHARED = {
  projectId: 'gundamwar',
  apiKey: 'AIzaSyCwYIzTSFtThkBTgr-lgXH9yqYe9GxKXzg',
};
