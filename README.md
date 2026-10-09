# Blockbench MCP

Blockbench'i Claude'dan kontrol etmek için bir MCP sunucusu ve ona eşlik eden Blockbench eklentisi.

Claude bununla model kurar, UV açar, doku boyar, kemik ve animasyon ekler, sonucu ekran görüntüsüyle
kontrol eder ve modeli Blockbench'in desteklediği formatlarda dışa aktarır. Minecraft tarzı küp
modellerin yanında low-poly, elle boyanmış karakterler de yapabilir. Modeli 2D oyunlar için pixel art
sprite'lara da çevirebilir.

Yaptığı her değişiklik Blockbench'in geri alma geçmişine yazılır. Beğenmediğin adımı `Ctrl+Z` ile geri
alabilirsin.

| | |
|---|---|
| **Sürüm** | 1.6.1 · [Sürüm notları](CHANGELOG.md) |
| **Blockbench** | 5.2 ve üstü önerilir. 5.1.4 de çalışır, ama 5.2'ye özgü araçlar orada "5.2 gerekir" hatası verir. |
| **İstemci** | Claude Desktop ve Claude Code. Geliştirme Windows'ta yapıldı. |
| **Node.js** | 18 ve üstü |
| **Araç sayısı** | 82 |

> **1.6.0 veya daha eski bir sürüm kullanıyorsan güncelle.** Eski sürümlerde, Blockbench ve MCP açıkken
> tarayıcında açık olan bir web sitesi köprüye bağlanıp bilgisayarında kod çalıştırabiliyordu. 1.6.1
> bunu kapatır. Ayrıntı: [Güvenlik](#güvenlik).

## Neler yapabilir

| Alan | Kapsam |
|---|---|
| Modelleme | Küp, mesh, plane, locator, bounding box. Gruplar animasyonda kemik olarak kullanılır. Simetrik parçalar için `mirror` ve `mirror_elements`. Hazır mesh şekilleri: plane, piramit, silindir, koni, küre, torus, icosphere, octahedron, dodecahedron. |
| Low-poly | Kesitlerden uzuv ve tüp (`add_loft`). Extrude, inset, loop cut, bevel, solidify, subdivide (`edit_mesh`). Taper, bend, twist, smooth (`transform_mesh`). |
| Doku | Şablon üretimi, katmanlar ve katman grupları, gradyan, gürültü, kürk çizgisi (`strands`), tırtıklı kenar (`jagged_edge`), küp ve mesh yüzlerine boyama. Işık, AO ve kenar bake'i (`bake_texture`). Ton kaydıran renk rampaları ve palete sabitleme (`palette`). |
| UV | Mesh UV açma: adalar, dikişler, parça başına yoğunluk (`unwrap_mesh`). Küp UV'si, otomatik UV, UV teşhisi (`inspect_uv`). |
| Animasyon | Keyframe (Molang ifadeleriyle), ayna keyframe, 20 hazır hareket, efekt keyframe'leri, IK ve pole, IK'yi normal keyframe'e çevirme. |
| Kontrol | Ekran görüntüsü, çoklu açı görüntüsü, animasyon önizlemesi, animasyon sırasında kesişme ve zemin teması kontrolü, yapım süreci GIF'i (`record_build`). |
| Referans | Referans görselle siluet karşılaştırma (`compare_reference`), referansı dokuya yansıtma (`project_reference`), sahnede referans model ve 3D referans görsel. |
| Export | bbmodel, Bedrock geo.json, Java block, glTF/GLB, OBJ, FBX, DAE, STL, OptiFine JEM, animasyon JSON. |
| Pixel art | Tek kare, 4/8/16 yönlü setler, Aseprite JSON'lu sprite sheet. |

### Blockbench 5.2 ile gelenler

5.2'de şunlar da açılır: doku katman grupları, pole destekli IK, sahnede hareket ettirilebilen referans
modeller, 3D panel olarak gösterilen referans görseller, Java 26.3 `shade_direction_override`, cushion
skin şablonu, Molang `variable_placeholders`, bounding box, `embedded` ve `on_shelf` display slotları,
glTF `merge_armature`. Bu Blockbench'te hangilerinin olduğunu `get_status` çıktısındaki `features`
alanı gösterir.

## Kurulum

### Hızlı yol: hazır sürüm

1. [Son sürüm](https://github.com/RenasDemirbas/BlockBenchMCP/releases/latest) sayfasından
   `blockbench_mcp.js` ve `mcp-server.js` dosyalarını indir. İkisi zip olarak da var. `npm install`
   gerekmez, sunucu bağımlılıklarıyla birlikte paketlendi.
2. İki dosyayı kalıcı bir klasöre koy. Blockbench eklentiyi bu yoldan yükler, klasörü taşırsan
   eklentiyi yeniden yüklemen gerekir.
3. [Eklentiyi Blockbench'e yükle](#eklentiyi-blockbenche-yükle) ve [Claude'a tanıt](#claudea-tanıt).

### Kaynaktan derleme

```bash
git clone https://github.com/RenasDemirbas/BlockBenchMCP.git
cd BlockBenchMCP
npm install
npm run build
```

Derleme sonunda `dist/` altında iki dosya oluşur:

- `blockbench_mcp.js`: Blockbench eklentisi
- `mcp-server.js`: MCP sunucusu (bağımlılıkları `node_modules` içinden okur)

Tek dosyalık, bağımlılıkları içine gömülü sunucu için `npm run build:release`.

### Eklentiyi Blockbench'e yükle

1. Blockbench'i aç ve **File → Plugins** menüsüne gir.
2. Sağ üstteki menüden **Load Plugin from File**'ı seç.
3. `blockbench_mcp.js` dosyasını göster ve güvenlik uyarısını onayla.

### Claude'a tanıt

**Claude Code:**

```bash
claude mcp add --scope user blockbench -- node /yol/mcp-server.js
```

**Claude Desktop:** `%APPDATA%\Claude\claude_desktop_config.json` dosyasındaki `mcpServers` bölümüne ekle:

```json
"blockbench": {
  "command": "node",
  "args": ["C:\\yol\\mcp-server.js"],
  "env": { "BB_BRIDGE_PORT": "8188" }
}
```

Ardından Claude Desktop'ı sistem tepsisinden tamamen kapatıp yeniden aç.

İkisi aynı anda çalışabilir. Portu ilk alan sunucu köprü görevini üstlenir, diğerleri komutlarını onun
üzerinden iletir.

### Bağlantıyı kontrol et

Blockbench açıkken Claude'a "Blockbench durumunu kontrol et" de. `get_status` bağlı bir Blockbench
sürümü döndürmelidir. Bağlantı yoksa [Sorun giderme](#sorun-giderme) bölümüne bak.

### Güncelleme

1. Yeni `blockbench_mcp.js` ve `mcp-server.js` dosyalarını eskilerin üstüne yaz (ya da `git pull` ve
   `npm run build`).
2. Blockbench'i yeniden başlat.
3. Claude Desktop'ı veya Claude Code oturumunu yeniden başlat. Çalışan sunucu eski sürümde kalır.

`get_status` çıktısındaki `plugin_version` yeni sürümü göstermelidir.

## Önerilen çalışma biçimi

Modeli tek seferde istemek yerine aşama aşama ilerlemek daha iyi sonuç veriyor. Her aşamadan sonra
ekran görüntüsüne bakıp düzeltme istemek, en sonda toplu düzeltme yapmaktan daha az iş çıkarır.

### Küp model (Minecraft tarzı varlık)

1. **Proje ve iskelet.** Formatı seç (`create_project`), sonra kemik ağacını kur (`add_groups`). Örneğin
   `body > head`, `body > leg_fl`. Animasyon bu gruplara uygulanacağı için bu adımı atlama.
2. **Geometri.** Küpleri gruplara yerleştir (`add_cubes`). Simetrik bacak ve kollar için `mirror: true`.
   Kürk, yaprak gibi ince parçalar için `add_planes`.
3. **Kontrol.** `capture_multi_view` ile önden, yandan ve üstten bak. Oranlar burada düzeltilir; doku
   boyandıktan sonra geometri değiştirmek UV'leri bozar.
4. **Doku.** Önce `generate_texture_template`, sonra `paint_texture` / `paint_faces`. Şablon olmadan
   birçok yüz aynı UV alanını paylaşır ve birini boyamak diğerlerini de boyar.
5. **Animasyon.** `create_animation`, `set_keyframes`, sol-sağ eşleşmesi için `mirror_keyframes`.
   Sonra `validate_model` ile animasyon sırasında iç içe geçen parça var mı, `query_geometry` ile ayaklar
   zemine basıyor mu kontrol et.
6. **Export.** `export_model` ve `export_animations`. 2D oyun için `export_pixel_sprites`.

Örnek istek:

> Bedrock entity formatında bir kurt modeli yap. Önce sadece iskelet ve gri küplerle şekli kur, üç
> açıdan görüntü göster. Onaylarsam doku ve yürüme animasyonuna geçelim.

### Low-poly, elle boyanmış karakter

PS1 tarzı, dokusu elle boyanmış karakterler için `free` formatında önerilen sıra:

1. **Referans.** `compare_reference` ile referans görseli aynı açıdan karşılaştır. Araç siluet
   benzerliğini (IoU) verir ve her yükseklik bandında modelin ne kadar geniş ya da dar kaldığını birim
   cinsinden söyler.
2. **Blok model.** Kollar, bacaklar, pantolon ve gövde için `add_loft`: halkaların merkezini ve
   boyutunu verirsin, sivrilen ve bükülen kutu uzuv çıkar. Şapka kenarı için `add_mesh_primitive`
   cylinder, pelerin için plane + `edit_mesh` solidify.
3. **Şekillendirme.** `transform_mesh` ile taper/bend/twist, `edit_mesh` ile extrude/inset/loop cut.
   Adımlar `select: "previous"` ile zincirlenir, yani extrude → inset → extrude tek çağrıda olur. Kutu
   parçaları `bevel` ile yumuşat. Her adımdan sonra tekrar `compare_reference`.
4. **UV.** `unwrap_mesh {pixel_density: 32-64, density_scale: {"head": 2}}`. Uzuvlar tek şerit ada
   olarak açılır. Önceden boyanmış piksel varsa yeni düzene taşınır.
5. **Düz renk.** `palette {action: "ramp"}` ile renk rampalarını seç, `paint_faces` ile düz renk ver.
   Mesh'lerde `faces: ["up"]` yukarı bakan yüzleri seçer. İstersen başlangıç için
   `project_reference` ile referansı dokuya yansıt.
6. **Bake.** `bake_texture {layer: "shading"}` ışığı, AO'yu ve kenar parlamasını ton kaydıran pixel-art
   basamakları olarak boyar. Ayrı katmana yazdığı için tekrar bake etmek gölgeyi üst üste bindirmez.
7. **Temizlik.** `palette {action: "quantize"}` ile kaçak renkleri palete sabitle.
8. **Kayıt.** Başta `record_build {action: "start"}` dersen her düzenleme bir kare olur. Sonda `stop`
   parça parça yapım GIF'ini yazar.

Bu akışın tamamını gösteren hazır bir örnek var. Dört kollu, gaz maskeli bir silahşor karakteri kurar
ve yapımı GIF olarak kaydeder. Senin açık modeline dokunmaz, yeni bir sekmede çalışır:

```bash
OUT=C:/cikti/klasoru node scripts/examples/build-gunslinger.mjs
```

### Koordinat kuralları

- 1 birim = 1/16 blok. Y yukarı bakar, zemin y=0.
- +X doğu, -Z kuzey. Varlıklar kuzeye (-Z) bakacak şekilde modellenir; `north` kamera açısı önü gösterir.
- Rotasyonlar derece cinsindendir, sıra ZYX. +X sarkan bir uzvu öne doğru savurur.

## Araçlar

| Alan | Araçlar |
|---|---|
| Proje | `get_status`, `list_formats`, `create_project`, `get_project_info`, `set_project_settings`, `open_project`, `save_project`, `select_project_tab`, `close_project` |
| Geometri | `add_groups`, `add_cubes`, `add_meshes`, `add_mesh_primitive`, `add_loft`, `edit_mesh`, `transform_mesh`, `add_planes`, `add_locators`, `add_bounding_boxes`, `list_outline`, `get_element`, `update_elements`, `delete_elements`, `duplicate_elements`, `mirror_elements`, `select_elements` |
| Doku | `create_texture`, `generate_texture_template`, `list_textures`, `get_texture`, `import_texture`, `apply_texture`, `paint_texture`, `paint_faces`, `bake_texture`, `palette`, `texture_layers`, `resize_texture`, `set_texture_resolution`, `delete_texture` |
| UV | `unwrap_mesh`, `set_cube_uv`, `set_mesh_uv`, `auto_uv`, `inspect_uv` |
| Animasyon | `create_animation`, `list_animations`, `get_animation`, `update_animation`, `delete_animation`, `set_keyframes`, `edit_keyframes`, `mirror_keyframes`, `add_effect_keyframes`, `apply_animation_preset`, `variable_placeholders`, `preview_animation`, `render_animation` |
| IK | `add_ik_controllers`, `bake_ik_animation` |
| Kontrol | `validate_model`, `query_geometry`, `capture_screenshot`, `capture_multi_view`, `record_build` |
| Referans | `compare_reference`, `project_reference` |
| Sahne | `preview_models`, `reference_images` |
| Pixel art | `render_pixel_art`, `export_pixel_sprites`, `pixel_art_presets` |
| Display | `set_display_transforms`, `get_display_transforms` |
| Dosya | `export_model`, `export_animations`, `import_model`, `get_model_json` |
| Diğer | `run_action`, `eval_code`, `undo`, `redo` |

Her aracın parametreleri MCP şemasında açıklanmıştır. Claude bunları kendisi okur.

## İpuçları

### Doku boyama

- `target: {element: "leg_fl", faces: "all"}` ile bir grubun tüm küplerini tek işlemde boyayabilirsin.
  Tüm model için `element: "*"`.
- Gradyanlara `space: "world"` ver. Bu ayar olmadan gradyan her küpte baştan başlar ve çok parçalı
  uzuvlar bantlı görünür. Çok duraklı gradyan için `stops`.
- Gölgeyi ayrı bir katmana boyayıp (`layer`) katmanı `multiply` moduna ve %50 opaklığa almak, sonradan
  ayarlamayı kolaylaştırır.
- Kürk siluetleri için `jagged_edge`, kürk dokusu için `strands`.
- Doku resim olarak doğru ama modelde yanlış görünüyorsa önce `inspect_uv` çalıştır. Tek bir yüzü
  yakından görmek için `get_texture` o yüzün UV bölgesini kırpıp büyütür.
- Model soluk ya da ızgaralı görünüyorsa sebep genelde dokuda değildir. Blockbench'in `brightness` ve
  `pixel_grid` ayarlarını kontrol et.

### Animasyon

- Keyframe değerleri Molang olabilir: `"math.sin(query.anim_time*360)*15"`.
- Zamanlar animasyonun FPS ızgarasına yuvarlanır (varsayılan 24). Tam değer gerekiyorsa `snap: false`.
  Zamanlamayı sonradan kaydırmak ya da keyframe silmek için `edit_keyframes`.
- Kemiğin rest rotasyonu varsa keyframe değerleri bu rotasyonun üstüne eklenir, mutlak açı değildir.
- Hızlı hareketler için `apply_animation_preset`: float, flap, swing, sway, shake, jump, flicker ve
  diğerleri.
- IK kullanan animasyonları Bedrock veya Java'ya aktarmadan önce `bake_ik_animation` ile normal
  rotasyon keyframe'lerine çevir.

### Pixel art

`render_pixel_art` modeli küçültülmüş bir ekran görüntüsü olarak değil, pixel art kurallarına göre
çizer. Ölçek doku pikseline hizalanır, kenar yumuşatma yapılmaz, gölgeler sınırlı sayıda renk bandıyla
verilir, siluete ve parça birleşimlerine 1 px kontur çekilir.

- **Açılar:** `side`, `front`, `back`, `top`, `three_quarter`, `top_down`, `isometric` (2:1),
  `true_isometric`. Serbest açı için `yaw` / `pitch`.
- **Yönler:** `directions: 8` sekiz yönlü set üretir. Simetrik modellerde `mirror_directions: true`
  ile render süresi kısalır.
- **Stil:** `outlined` (varsayılan), `clean`, `minecraft`, `flat`.
- **Palet:** varsayılan olarak modelin kendi renkleri. `pico8`, `sweetie16`, `endesga32`, `db32` gibi
  sabit paletler ya da kendi hex listen de verilebilir. İstersen Bayer dither.
- **Sprite sheet:** `export_pixel_sprites` animasyonları tek bir PNG ve Aseprite uyumlu bir JSON olarak
  yazar. Ölçek ve pivot bütün kareler için bir kez hesaplanır, böylece kareler arasında kayma olmaz.

Tüm seçenekleri görmek için Claude'dan `pixel_art_presets` çıktısını isteyebilirsin.

### Dosya yolları

Kayıt ve export için mutlak yol gerekir. `get_status` ev, masaüstü ve geçici klasörlerin yolunu,
`get_project_info` her dosya türü için son kullanılan klasörü döndürür. Claude yolu bunlardan öğrenir.

## Nasıl çalışır

```
Claude ──stdio──► MCP sunucusu (mcp-server.js)
                       │  ws://127.0.0.1:8188
                       ▼
             Blockbench eklentisi (blockbench_mcp.js)
```

WebSocket sunucusu MCP tarafında çalışır, eklenti ona bağlanır. Bu yüzden Blockbench tarafında ağ
izni istenmez. Blockbench kapanırsa sunucu açık kalır. Blockbench yeniden açılınca eklenti birkaç
saniye içinde kendiliğinden bağlanır.

Pencere arka plandayken tarayıcı motoru zamanlayıcıları yavaşlatır. Eklenti bunu atlatır, böylece uzun
işlemler Blockbench küçültülmüşken de çalışır.

Port varsayılan olarak 8188'dir. Değiştirmek için hem `BB_BRIDGE_PORT` ortam değişkenini hem de
Blockbench'teki **Settings → General → MCP Bridge Port** ayarını aynı değere getir.

## Güvenlik

- **Köprü sadece bu bilgisayarda dinler** (`127.0.0.1`). Ağdaki başka cihazlar bağlanamaz.
- **Web siteleri köprüye bağlanamaz** (1.6.1). Sunucu sadece Origin başlığı olmayan bağlantıları (Node)
  ve Blockbench penceresini (`file://`) kabul eder, gerisini bağlantı anında reddeder. Bilgisayarında
  çalışan programlar yine bağlanabilir; bunlar zaten senin yetkilerinle çalıştığı için ek bir risk
  getirmez.
- **`eval_code` Blockbench'i kilitleyemez.** İzin penceresi açan Node modülleri (`fs`, `child_process`
  ve benzerleri) kod çalışmadan önce reddedilir. Gerekirse `allow_native_modules: true` ile açılır, o
  durumda Blockbench penceresi önde olmalıdır.
- **Her değişiklik geri alınabilir.** Araçlar Blockbench'in geri alma geçmişine yazar.
- **Paylaştığın `.bbmodel` dosyasında yerel yollar olabilir.** Blockbench animasyon dosyasının tam
  yolunu kaydeder. Bu yol, bilgisayarındaki kullanıcı adını içerebilir. Dosyayı paylaşmadan önce
  kontrol et.

## Geliştirme

```bash
npm run build           # eklenti ve sunucu
npm run build:release   # bağımlılıkları gömülü tek dosyalık sunucu (release için)
npm run typecheck
```

Eklentiyi değiştirdikten sonra Blockbench'i yeniden başlatmana gerek yok:

```bash
node scripts/call-tool.mjs eval_code '{"code":"setTimeout(() => Plugins.devReload(), 300); \"ok\"","undo":false}'
```

Açık bir Claude oturumunun araç listesi sunucu başlarken sabitlenir. Yeni bir aracı oturumu yeniden
başlatmadan denemek için:

```bash
node scripts/call-tool.mjs render_pixel_art '{"view":"isometric","size":64}' --images e2e-output/tmp
```

### Testler

| Script | Ne test eder | Gereken |
|---|---|---|
| `smoke-test.mjs` | MCP protokolü ve köprü, sahte eklentiyle | Hiçbir şey |
| `verify-bridge-origin.mjs` | Köprü web sitelerinden gelen bağlantıları reddediyor mu | Hiçbir şey |
| `e2e-test.mjs` | Tam modelleme senaryosu | Açık Blockbench |
| `e2e-pro-test.mjs` | Doğrulama, sorgu, ayna, boyama | Açık Blockbench |
| `verify-paint-ops.mjs` | Boyama işlemleri | Açık Blockbench |
| `verify-field-fixes.mjs` | 1.3 düzeltmeleri | Açık bir proje |
| `verify-v52-features.mjs` | Blockbench 5.2 özellikleri | Blockbench 5.2 |
| `verify-pixel-art.mjs` | Pixel art çıktıları (PNG ve JSON) | Açık Blockbench |
| `verify-lowpoly-tools.mjs` | Mesh boyama, unwrap, edit/loft/transform, bake, palet, referans, kayıt. Bölüm seçmek için `node scripts/verify-lowpoly-tools.mjs paint,bake` | Açık Blockbench, referans testleri için `REF_DIR` |
| `verify-hidden-window-timers.mjs` | Pencere arka plandayken zamanlayıcılar | Küçültülmüş Blockbench |

Hepsi `node scripts/<ad>` ile çalışır.

## Sorun giderme

- **"Blockbench is not connected"**
  1. Blockbench açık mı?
  2. **File → Plugins** altında eklenti yüklü ve etkin mi?
  3. Port ayarı iki tarafta aynı mı? (Varsayılan 8188.)
- **Güncelledim ama eski davranış devam ediyor.** Claude oturumunu yeniden başlat. Çalışan sunucu
  süreci eski dosyayı kullanmaya devam eder.
- **Uzun işlemler pencere arka plandayken zaman aşımına uğruyor.** `get_status` çıktısında
  `timers.unthrottled` alanı `true` olmalı. `false` ise Blockbench penceresini öne al.
- **Loglar**
  - Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-blockbench.log`
  - Blockbench: `Ctrl+Shift+I` → Console → `[MCP]` satırları
