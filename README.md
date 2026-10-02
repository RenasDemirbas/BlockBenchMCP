# Blockbench MCP

Blockbench'i Claude'dan kontrol etmek için bir MCP sunucusu ve ona eşlik eden Blockbench eklentisi.
Claude model kurabilir, UV açabilir, doku boyayabilir, kemik ve animasyon ekleyebilir, sonucu ekran
görüntüsüyle kontrol edebilir ve modeli Blockbench'in desteklediği formatlarda dışa aktarabilir.
Modeli 2D oyunlarda kullanılacak pixel art sprite'lara da çevirebilir.

Yaptığı her değişiklik Blockbench'in geri alma geçmişine yazılır. Beğenmediğin adımı `Ctrl+Z` ile geri
alabilirsin.

- **Blockbench:** 5.2 ve üstü önerilir. 5.1.4 de çalışır, ama 5.2'ye özgü araçlar orada "5.2 gerekir"
  hatası verir.
- **İstemci:** Claude Desktop ve Claude Code. Geliştirme Windows'ta yapıldı.
- **Node.js:** 18 ve üstü.

## Neler yapabilir

| Alan | Kapsam |
|---|---|
| Modelleme | Küp, mesh, plane, locator, bounding box. Gruplar animasyonda kemik olarak kullanılır. Simetrik parçalar için `mirror` desteği var. |
| Doku | Şablon üretimi, katmanlar, gradyan, gürültü, kürk çizgisi (`strands`), yüz bazında boyama, UV teşhisi |
| Animasyon | Keyframe (Molang ifadeleriyle), ayna keyframe, hazır animasyonlar, efekt keyframe'leri, IK ve pole |
| Kontrol | Ekran görüntüsü, çoklu açı görüntüsü, animasyon önizlemesi, kesişme ve zemin teması kontrolü |
| Export | bbmodel, Bedrock geo.json, Java, glTF/GLB, OBJ, FBX, DAE, STL, JEM, animasyon JSON |
| Pixel art | Tek kare, 4/8/16 yönlü setler, Aseprite JSON'lu sprite sheet |

## Kurulum

### 1. Projeyi derle

```bash
git clone https://github.com/RenasDemirbas/BlockBenchMCP.git
cd BlockBenchMCP
npm install
npm run build
```

Derleme sonunda iki dosya oluşur:

- `dist/blockbench_mcp.js`: Blockbench eklentisi
- `dist/mcp-server.js`: MCP sunucusu

### 2. Eklentiyi Blockbench'e yükle

1. Blockbench'i aç ve **File → Plugins** menüsüne gir.
2. Sağ üstteki menüden **Load Plugin from File**'ı seç.
3. `dist/blockbench_mcp.js` dosyasını göster ve güvenlik uyarısını onayla.

Blockbench eklentiyi bu dosya yolundan yükler. Klasörü taşırsan eklentiyi yeniden yüklemen gerekir.

### 3. Claude'a tanıt

**Claude Desktop:** `%APPDATA%\Claude\claude_desktop_config.json` dosyasındaki `mcpServers` bölümüne ekle:

```json
"blockbench": {
  "command": "node",
  "args": ["C:\\yol\\BlockBenchMCP\\dist\\mcp-server.js"],
  "env": { "BB_BRIDGE_PORT": "8188" }
}
```

Ardından Claude Desktop'ı sistem tepsisinden tamamen kapatıp yeniden aç.

**Claude Code:**

```bash
claude mcp add --scope user blockbench -- node /yol/BlockBenchMCP/dist/mcp-server.js
```

İkisi aynı anda çalışabilir. Portu ilk alan sunucu köprü görevini üstlenir, diğerleri komutlarını onun
üzerinden iletir.

### 4. Bağlantıyı kontrol et

Blockbench açıkken Claude'a "Blockbench durumunu kontrol et" de. `get_status` bağlı bir Blockbench
sürümü döndürmelidir. Bağlantı yoksa [Sorun giderme](#sorun-giderme) bölümüne bak.

## Önerilen çalışma biçimi

Modeli tek seferde istemek yerine aşama aşama ilerlemek daha iyi sonuç veriyor. Her aşamadan sonra
ekran görüntüsüne bakıp düzeltme istemek, en sonda toplu düzeltme yapmaktan daha az iş çıkarır.

1. **Proje ve iskelet.** Formatı seç (`create_project`), sonra kemik ağacını kur (`add_groups`). Örneğin
   `body > head`, `body > leg_fl` gibi. Animasyon bu gruplara uygulanacağı için bu adımı atlama.
2. **Geometri.** Küpleri gruplara yerleştir (`add_cubes`). Simetrik bacak ve kollar için `mirror: true`
   kullan. Kürk, yaprak gibi ince parçalar için `add_planes`.
3. **Kontrol.** `capture_multi_view` ile önden, yandan ve üstten bak. Oranlar burada düzeltilir; doku
   boyandıktan sonra geometri değiştirmek UV'leri bozar.
4. **Doku.** Önce `generate_texture_template`, sonra `paint_texture` / `paint_faces`. Şablon olmadan
   birçok yüz aynı UV alanını paylaşır ve birini boyamak diğerlerini de boyar.
5. **Animasyon.** `create_animation`, `set_keyframes`, sol-sağ eşleşmesi için `mirror_keyframes`.
   Sonra `validate_model` ile animasyon sırasında iç içe geçen parça var mı kontrol et.
6. **Export.** `export_model` ve `export_animations`. 2D oyun için `export_pixel_sprites`.

Örnek istek:

> Bedrock entity formatında bir kurt modeli yap. Önce sadece iskelet ve gri küplerle şekli kur, üç
> açıdan görüntü göster. Onaylarsam doku ve yürüme animasyonuna geçelim.

### Koordinat kuralları

- 1 birim = 1/16 blok. Y yukarı bakar, zemin y=0.
- Varlıklar kuzeye (-Z) bakacak şekilde modellenir.
- Rotasyonlar derece cinsindendir. +X sarkan bir uzvu öne doğru savurur.

## Araçlar

Toplam 73 araç var.

| Alan | Araçlar |
|---|---|
| Proje | `get_status`, `list_formats`, `create_project`, `get_project_info`, `set_project_settings`, `open_project`, `save_project`, `select_project_tab`, `close_project` |
| Geometri | `add_groups`, `add_cubes`, `add_meshes`, `add_mesh_primitive`, `add_planes`, `add_locators`, `add_bounding_boxes`, `list_outline`, `get_element`, `update_elements`, `delete_elements`, `duplicate_elements`, `mirror_elements`, `select_elements` |
| Doku | `create_texture`, `generate_texture_template`, `list_textures`, `get_texture`, `import_texture`, `apply_texture`, `paint_texture`, `paint_faces`, `texture_layers`, `resize_texture`, `set_texture_resolution`, `delete_texture` |
| UV | `set_cube_uv`, `set_mesh_uv`, `auto_uv`, `inspect_uv` |
| Animasyon | `create_animation`, `list_animations`, `get_animation`, `update_animation`, `delete_animation`, `set_keyframes`, `edit_keyframes`, `mirror_keyframes`, `add_effect_keyframes`, `apply_animation_preset`, `variable_placeholders`, `preview_animation`, `render_animation` |
| IK | `add_ik_controllers`, `bake_ik_animation` |
| Kontrol | `validate_model`, `query_geometry`, `capture_screenshot`, `capture_multi_view` |
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
  uzuvlar bantlı görünür.
- Gölgeyi ayrı bir katmana boyayıp katmanı `multiply` moduna ve %50 opaklığa almak, sonradan
  ayarlamayı kolaylaştırır.
- Doku resim olarak doğru ama modelde yanlış görünüyorsa önce `inspect_uv` çalıştır.
- Model soluk ya da ızgaralı görünüyorsa sebep genelde dokuda değildir. Blockbench'in `brightness` ve
  `pixel_grid` ayarlarını kontrol et.

### Animasyon

- Keyframe değerleri Molang olabilir: `"math.sin(query.anim_time*360)*15"`.
- Zamanlar animasyonun FPS ızgarasına yuvarlanır (varsayılan 24). Tam değer gerekiyorsa `snap: false`.
- Kemiğin rest rotasyonu varsa keyframe değerleri bu rotasyonun üstüne eklenir, mutlak açı değildir.
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
- **Palet:** varsayılan olarak modelin kendi renkleri. `pico8`, `endesga32`, `db32` gibi sabit paletler
  ya da kendi hex listen de verilebilir.
- **Sprite sheet:** `export_pixel_sprites` animasyonları tek bir PNG ve Aseprite uyumlu bir JSON olarak
  yazar. Ölçek ve pivot bütün kareler için bir kez hesaplanır, böylece kareler arasında kayma olmaz.

Tüm seçenekleri görmek için Claude'dan `pixel_art_presets` çıktısını isteyebilirsin.

## Nasıl çalışır

```
Claude ──stdio──► MCP sunucusu (dist/mcp-server.js)
                       │  ws://127.0.0.1:8188
                       ▼
             Blockbench eklentisi (dist/blockbench_mcp.js)
```

WebSocket sunucusu MCP tarafında çalışır, eklenti ona bağlanır. Bu yüzden Blockbench tarafında ağ
izni istenmez. Blockbench kapanırsa sunucu açık kalır. Blockbench yeniden açılınca eklenti birkaç
saniye içinde kendiliğinden bağlanır.

Port varsayılan olarak 8188'dir. Değiştirmek için hem `BB_BRIDGE_PORT` ortam değişkenini hem de
Blockbench'teki **Settings → General → MCP Bridge Port** ayarını aynı değere getir.

## Geliştirme

```bash
npm run build       # eklenti ve sunucu
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
| `e2e-test.mjs` | Tam modelleme senaryosu | Açık Blockbench |
| `e2e-pro-test.mjs` | Doğrulama, sorgu, ayna, boyama | Açık Blockbench |
| `verify-paint-ops.mjs` | Boyama işlemleri | Açık Blockbench |
| `verify-field-fixes.mjs` | 1.3 düzeltmeleri | Açık bir proje |
| `verify-v52-features.mjs` | Blockbench 5.2 özellikleri | Blockbench 5.2 |
| `verify-pixel-art.mjs` | Pixel art çıktıları (PNG ve JSON) | Açık Blockbench |
| `verify-hidden-window-timers.mjs` | Pencere arka plandayken zamanlayıcılar | Küçültülmüş Blockbench |

Hepsi `node scripts/<ad>` ile çalışır.

## Sorun giderme

- **"Blockbench is not connected"**
  1. Blockbench açık mı?
  2. **File → Plugins** altında eklenti yüklü ve etkin mi?
  3. Port ayarı iki tarafta aynı mı? (Varsayılan 8188.)
- **Uzun işlemler pencere arka plandayken zaman aşımına uğruyor.** Tarayıcı motoru arka plandaki
  pencerede zamanlayıcıları yavaşlatır. Eklenti bunu atlatır. `get_status` çıktısında
  `timers.unthrottled` alanı `true` olmalı. `false` ise Blockbench penceresini öne al.
- **Paylaştığın `.bbmodel` dosyasında yerel yollar görünüyor.** Blockbench animasyon dosyasının tam
  yolunu kaydeder. Bu yol, bilgisayarındaki kullanıcı adını içerebilir. Dosyayı paylaşmadan önce
  kontrol et.
- **Loglar**
  - Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-blockbench.log`
  - Blockbench: `Ctrl+Shift+I` → Console → `[MCP]` satırları

Sürüm notları için [CHANGELOG.md](CHANGELOG.md).
