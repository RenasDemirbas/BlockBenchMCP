# Blockbench MCP

Claude'un Blockbench'i uçtan uca kullanmasını sağlayan tam kapsamlı bir MCP (Model Context Protocol) sunucusu: modelleme, doku/boyama, UV, **kemik (rig) animasyonları ve grup-bazlı animasyonlar**, item display ayarları, ekran görüntüsüyle görsel geri bildirim ve tüm formatlara export.

Hedef sürüm: **Blockbench 5.2+** (5.1.4+ da çalışır; 5.2'ye özgü araçlar orada net bir "5.2 gerekir" hatası verir) · İstemci: **Claude Desktop (Windows)**

## Mimari

```
Claude Desktop ──stdio──► MCP server (dist/mcp-server.js, Node)
                              │  ws://127.0.0.1:8188  (WS sunucusu MCP tarafında)
                              ▼
                  Blockbench eklentisi (dist/blockbench_mcp.js)
                  WebSocket İSTEMCİSİ olarak dışarı bağlanır → izin promptu yok
```

- MCP server WebSocket sunucusunu barındırır; eklenti dışarıya bağlanır (Blockbench 5'in modül kısıtlamaları nedeniyle en temiz yol).
- Blockbench kapansa bile MCP server ayakta kalır; eklenti ~2.5 sn'de bir otomatik yeniden bağlanır.
- Tüm düzenlemeler Blockbench'in Undo sistemine sarılıdır (Ctrl+Z ile geri alınabilir).

## Kurulum

### 1. Derleme (yapıldı)

```bash
npm install
npm run build
```

Çıktılar: `dist/blockbench_mcp.js` (eklenti) ve `dist/mcp-server.js` (MCP sunucusu).

### 2. Blockbench eklentisini yükle (tek seferlik)

1. Blockbench'i aç
2. **File → Plugins** (Eklentiler penceresi)
3. Sağ üstteki **⋮ menüsü → Load Plugin from File**
4. `C:\path\to\BlockBenchMCP\dist\blockbench_mcp.js` dosyasını seç
5. Çıkan güvenlik uyarısını onayla

Eklenti bundan sonra her Blockbench açılışında otomatik yüklenir (dosya yolundan okunur — dosyayı taşıma). Eklentiyi güncelledikten sonra Blockbench'te `Reload Plugins` aksiyonunu çalıştırman ya da uygulamayı yeniden başlatman yeterli.

### 3. Claude Desktop yapılandırması (yapıldı)

`%APPDATA%\Claude\claude_desktop_config.json` dosyasına şu girdi eklendi:

```json
"blockbench": {
  "command": "node",
  "args": ["C:\\path\\to\\BlockBenchMCP\\dist\\mcp-server.js"],
  "env": { "BB_BRIDGE_PORT": "8188" }
}
```

Claude Desktop'ı **tamamen** yeniden başlat (sistem tepsisinden çıkış yap). Sonrasında Blockbench açıkken Claude'a "Blockbench'te bir kurt modeli yap ve yürüme animasyonu ekle" diyebilirsin.

Ayrıca **Cowork / kod oturumları** için kullanıcı kapsamında kayıt yapıldı (`claude mcp add --scope user blockbench`) — yani hem klasik sohbet hem kod oturumları MCP'yi görür. İki yüzey aynı anda çalışırsa sunucu örnekleri çakışmaz: portu ilk alan "hub" olur, diğerleri komutlarını hub üzerinden aktarır.

## Araçlar (70)

| Alan | Araçlar |
|---|---|
| Proje | `get_status`, `list_formats`, `create_project` (skin şablonları), `get_project_info`, `set_project_settings`, `open_project`, `save_project`, `select_project_tab`, `close_project` |
| Geometri | `add_groups` (kemikler!), `add_cubes`, `add_meshes`, `add_mesh_primitive`, `add_planes`, `add_locators`, `add_bounding_boxes`, `list_outline`, `get_element`, `update_elements`, `delete_elements`, `duplicate_elements`, `select_elements` |
| Doku | `create_texture`, `generate_texture_template`, `list_textures`, `get_texture`, `import_texture`, `apply_texture`, `paint_texture`, `paint_faces`, `texture_layers`, `resize_texture`, `set_texture_resolution` |
| UV | `set_cube_uv`, `set_mesh_uv`, `auto_uv`, `inspect_uv` (eşleme teşhisi) |
| Animasyon | `create_animation`, `list_animations`, `get_animation`, `update_animation`, `delete_animation`, `set_keyframes` (Molang destekli), `edit_keyframes`, `mirror_keyframes`, `add_effect_keyframes`, `apply_animation_preset`, `variable_placeholders`, `preview_animation`, `render_animation` |
| IK | `add_ik_controllers` (pole destekli), `bake_ik_animation` |
| Sahne | `preview_models` (referans modeller), `reference_images` (3D plane dahil) |
| Görüntü | `capture_screenshot`, `capture_multi_view` |
| Display | `set_display_transforms`, `get_display_transforms` |
| I/O | `export_model` (bbmodel/geo.json/java/gltf/glb/obj/fbx/dae/stl/jem), `export_animations`, `import_model`, `get_model_json` |
| Kaçış | `run_action`, `eval_code`, `undo`, `redo` |

## Texture boyama (v1.2)

- **Önce `generate_texture_template`.** Aksi halde birçok yüz tek bir UV dikdörtgenini paylaşır ve
  birini boyamak diğerlerini de boyar. `inspect_uv` bunu `shared_uv_rect` bulgusu olarak bildirir.
- **Toplu hedefleme:** `target: {element: "<grup>", faces: "all"}` — `element` bir grup olabilir, op
  içindeki her küpün her yüzü için ayrı ayrı uygulanır. Tek op bütün bir bacağı kaplar.
- **Çok duraklı gradyan:** `stops: [{at, color, opacity}]`. Üstte açık, ortada saydam, altta koyu bir
  rampa tek op'ta hacim verir.
- **`space: "world"`:** gradyanı yüzün kendi 0-1 kutusu yerine **modelin Y aralığına** yayar. Yüz-yerel
  gradyan her küpte sıfırlandığı için çok parçalı bir bacak bantlı görünür; `world` ile komşu küpler
  aynı rampayı sürdürür.
- **`strands` op'u:** kürk çizgileri; adet ve uzunluk hedef dikdörtgenin boyutundan türetilir, böylece
  aynı op küçük bir pençede de büyük bir böğürde de doğru okur. Kısa tutun — uzun teller kürk değil
  ahşap damarı gibi görünür.
- **`noise`** hedef ve `from`/`to` verilmezse tüm bitmap'i kaplar.
- Bir doku görüntü olarak doğru ama **modelde yanlış** görünüyorsa ilk iş `inspect_uv`.

## Saha geri bildirimi düzeltmeleri (v1.3)

- **`eval_code` artık Blockbench'i kilitleyemez.** Kök neden bir sonsuz döngü değil: Blockbench'in
  eklenti-kapsamlı `require`'ı, `SAFE_APIS` dışındaki her modül için `dialog.showMessageBoxSync`
  çağırır (`js/native_apis.ts`) — **senkron, yerel, modal** bir izin kutusu. Renderer'ı tamamen
  bloklar ve pencere simge durumundayken **görünmez**; uygulama donmuş görünür, köprü düşer.
  Artık bu tür `require` çağrıları kod çalışmadan **önce** reddedilir ve hata mesajı alternatifi
  gösterir. Serbest modüller: `path, crypto, events, zlib, timers, url, string_decoder,
  querystring, constants, buffer, stream, perf_hooks`. Gerçekten gerekiyorsa pencereyi öne alıp
  `allow_native_modules: true` gönderin.
- **`eval_code` üst seviyede `return` ve `await` kabul ediyor** — IIFE sarmaya gerek yok. Son ifadenin
  değerini döndürme davranışı korunuyor (kod yalnızca ayrıştırıcı itiraz ettiğinde async fonksiyona sarılır).
- **Dosya yolları artık MCP içinden öğrenilebiliyor.** `get_status` → `paths` (home, desktop, temp,
  ayraç), `get_project_info` → ayrıca kullanıcının her dosya türü için **en son kullandığı klasör**
  (`paths.last_used.model/texture/screenshot/gltf/…`) ve son projelerin yolları. Kaynak: `SystemInfo`
  ve `StateMemory.dialog_paths` global'leri — `require('os')` gerekmiyor.
- **Boş grup hedefi net hata veriyor.** Bir rigin tepe kemiği (çoğu zaman `root`) küp içermez;
  hata artık kaç çocuğu olduğunu ve küp içeren grupları listeler. Tüm modeli hedeflemek için
  `element: "*"` (`paint_faces`, `paint_texture`, `get_texture`).
- **Keyframe zamanlaması görünür oldu.** Zamanlar animasyonun FPS ızgarasına (`snapping`, varsayılan 24)
  yuvarlanır: 0.3 s → 0.29167 s, 1.2 s → 1.20833 s. `set_keyframes` taşınan her zamanı `snapped`
  altında bildirir; **`snap: false`** ile tam zaman yazılır. `edit_keyframes` retime/silme aracıdır
  (`set_time`, `time_offset`, `time_scale`, `delete`, `resize_to_content`). `update_animation` artık
  **daha kısa** bir `length` uygular ve sona taşan keyframe'leri uyarı olarak listeler.
  (Blockbench'in `getMaxLength()`'i akümülatörü `this.length` ile başlattığı için klip hiç kısalamıyordu.)
- **Rest rotation toplanabilirliği bildiriliyor.** Kemiğin sıfır olmayan rest rotasyonu varsa
  `set_keyframes` sonucunda `rest_rotation` + uyarı döner: keyframe değerleri mutlak açı değil, **delta**.
- **`get_texture` tek yüzü kırpıp büyütüyor:** `{element, face}` (veya `faces`, `padding`) ile atlasın
  sadece o UV bölgesi `max_size`'a kadar **büyütülerek** döner; sonuçta piksel bölgesi ve eşleşen
  yüzlerin listesi de var. Artık `eval_code` ile elle canvas crop yazmaya gerek yok.

## Blockbench 5.2 entegrasyonu (v1.4)

`get_status` → `features` bu kurulumda hangi 5.2 yeteneklerinin olduğunu söyler.

- **Katmanlar ve katman grupları** — `texture_layers`: listele, `add_layer`, `add_group` (5.2),
  `update` (opaklık 0-1, blend mode, görünürlük, gruba taşıma, sıra), `merge_down`, `ungroup`, `disable`
  (düzleştir). `paint_texture` / `paint_faces` → **`layer`**: o katmana boyar, yoksa oluşturur. Gölgeyi
  ayrı katmana boya, sonra `multiply` + %50 yap. `get_texture` → `layer`: tek katmanı gösterir.
  Düzeltme: boyama artık katman **offset**'ini hesaba katıyor (önceden offset'li katmanda kayıyordu) ve
  `resize_texture` katmanlı dokuda tüm katmanları ölçekliyor.
- **IK + pole** — `add_ik_controllers`: `target` (ayak/el) + `source` (uyluk/üst kol) zinciri için null
  object kontrolcü; `pole_offset: [0,0,-8]` dizi öne büken pole'u otomatik kurar. Kontrolcünün `position`
  kanalı `set_keyframes` ile anime edilir. 5.2.1+'da kontrolcü yalnızca keyframe'i olan animasyonlarda
  çalışır → `animations` nötr keyframe ekler. `bake_ik_animation`: IK'yı Bedrock/Java export'u için
  rotasyon keyframe'lerine çevirir. `update_elements` null object'lerde `ik_target/ik_source/ik_pole/
  lock_ik_target_rotation` düzenler; ters zincir açıklamalı hata verir.
- **Hareketli referans modeller** — `preview_models`: oyuncu, çalışma masası (5.2) vb. aç/kapat, taşı,
  döndür, ölçekle (yeniden başlatmada hatırlanır). Ekran görüntülerinde görünürler;
  `capture_screenshot` → `include_reference_models: true` kadrajı onlara da genişletir.
- **3D referans görseller** — `reference_images`: `view_mode: "plane"` ile görsel sahnede bir panel olur
  (`plane_position`, `plane_rotation`, `plane_size` model birimi). Kullanıcı içindir; ekran görüntüsünde çıkmaz.
- **Yeni mesh primitive'leri** — `add_mesh_primitive`: `icosphere`, `octahedron`, `dodecahedron` +
  `detail` (0-4). Gerçek çap kullanılır ve y=0'a oturur (Blockbench diyaloğu çapı yarıçap olarak veriyor).
- **Java 26.3 shade direction override** — `add_cubes` / `update_elements` → `shade_direction_override`;
  `set_project_settings` → `java_block_version: "26.3"`.
- **Skin şablonları** — `create_project {format: "skin", skin_model: "cushion"}` (5.2'nin yeni cushion'ı,
  steve, alex ve tüm moblar); bilinmeyen id tam listeyi döner.
- **Molang değişken yer tutucuları** — `variable_placeholders`: value/slider/toggle/impulse satırları
  (5.2'nin Create Variable Placeholder söz dizimi) ve slider değerleri; Molang'lı animasyonlar önizlemede
  gerçekten hareket eder.
- **Diğer** — generic formatta `add_bounding_boxes` (collision/hitbox); display slotları `embedded`,
  `on_shelf`; bedrock_block'ta yeni slot oyun varsayılanlarıyla başlar; glTF export `merge_armature`
  seçeneği; efekt keyframe `file` yolları .bbmodel'e göreli olabilir.

## Önemli kavramlar

- **Gruplar = kemikler.** Blockbench'te animasyon gruplara uygulanır. Rigli model = derin grup hiyerarşisi; blok-bazlı animasyon = küp kümelerini saran yüzeysel gruplar. Her ikisi de aynı `set_keyframes` aracıyla çalışır.
- **Keyframe değerleri Molang olabilir**: `"math.sin(query.anim_time*360)*15"` gibi ifadelerle prosedürel hareket.
- **Görsel döngü**: `capture_screenshot`, `capture_multi_view`, `preview_animation`, `render_animation` araçları görüntü döndürür — model her adımda görülerek geliştirilir.

## Test

```bash
node scripts/smoke-test.mjs   # MCP + köprü + sahte eklenti ile uçtan uca protokol testi
node scripts/e2e-test.mjs     # Gerçek Blockbench ile tam senaryo (Blockbench açık ve eklenti yüklü olmalı)
node scripts/e2e-pro-test.mjs # v1.1 araçları (validate/query/mirror/paint) — gerçek Blockbench
node scripts/verify-hidden-window-timers.mjs  # Pencere gizliyken timer throttling regresyonu
node scripts/verify-paint-ops.mjs             # v1.2 boyama op'ları (toplu hedef, stops, space:world, strands)
node scripts/verify-field-fixes.mjs           # v1.3 saha düzeltmeleri (açık bir proje gerekir)
node scripts/verify-v52-features.mjs          # v1.4 Blockbench 5.2 entegrasyonu (kendi projelerini açıp kapatır)
```

Yeni bir aracı/parametreyi **oturum yeniden başlatmadan** denemek için (açık bir sohbetin araç listesi
sunucu başlarken sabitlenir):

```bash
node scripts/call-tool.mjs inspect_uv '{}'
```

`verify-hidden-window-timers.mjs` yalnızca Blockbench penceresi **simge durumundayken / tamamen örtülüyken**
anlamlıdır; pencere önplandaysa hatayı üretemeyeceğini söyleyip geçer.

## Sorun giderme

- **Uzun işlemler (özellikle `generate_texture_template`) pencere arka plandayken zaman aşımına uğruyor** →
  Chromium gizli bir sayfada timer'ları ~1/saniyeye düşürür; Blockbench ise uzun işlemleri
  `setTimeout(…, 1)` ile adım adım ilerletir. Eklenti bunu Node'un `timers` modülüne yönlendirerek çözer
  (`plugin/src/timers.ts`). `get_status` çıktısındaki `timers.unthrottled` alanı `true` olmalı; `false` ise
  yama kurulamamış demektir (o durumda pencereyi önplana alın).
- **"Blockbench is not connected"** → Blockbench açık mı? Eklenti yüklü ve etkin mi? (File → Plugins) Port ayarı (Settings → General → MCP Bridge Port) 8188 mi?
- Claude Desktop logları: `%APPDATA%\Claude\logs\mcp-server-blockbench.log`
- Blockbench tarafı log: Blockbench içinde `Ctrl+Shift+I` → Console → `[MCP]` satırları.
