# Değişiklik günlüğü

## Yayınlanmadı

- Güvenlik: köprü artık tarayıcıdan gelen WebSocket bağlantılarını reddediyor. Önceden Blockbench ve MCP
  açıkken herhangi bir web sitesi `ws://127.0.0.1:8188` üzerinden `eval_code` gönderip bilgisayarda kod
  çalıştırabiliyordu. Yalnızca Origin başlığı olmayan (Node) ve `file://` (Blockbench) bağlantıları kabul
  ediliyor. Test: `scripts/verify-bridge-origin.mjs`.

## 1.6.0 — Low-poly karakter araçları

- Mesh boyama: `paint_texture`, `paint_faces` ve `get_texture` artık mesh yüzlerini de hedefliyor. UV
  poligonu piksel tam kırpılıyor, `space: "world"` gradyanı texel başına hesaplanıyor. Mesh'lerde yön
  adı (`"up"`) o yöne bakan tüm yüzleri seçer. `inspect_uv` mesh UV sorunlarını ve texel yoğunluğunu
  raporlar.
- `unwrap_mesh`: bağlı mesh yüzleri adalara birleşir. Dikiş (seam) kontrolü, parça başına yoğunluk
  (`density_scale`), eski boyanın yeni düzene taşınması.
- `edit_mesh`: Blockbench'in extrude, inset, solidify, loop cut, merge, dissolve, create/invert face ve
  split araçları; ek olarak subdivide, bevel, delete ve merge_meshes. Adımlar `select: "previous"` ile
  zincirlenir.
- `add_loft`: halkalardan kutu, yuvarlak ya da özel profilli uzuv ve tüp. `transform_mesh`: taper,
  bend, twist, scale, rotate, move, smooth, jitter.
- `bake_texture`: ışık yönü, ışın izlemeli ambient occlusion, dışbükey kenar parlaması ve iç bükey
  kıvrım gölgesi, yükseklik gradyanı ve gren. Sonuç her texel'in kendi renginden türeyen ton kaydıran
  pixel-art rampasına oturur.
- `palette`: ton kaydıran rampalar, renk çıkarma, `auto` / sabit palet / rampalara sabitleme (dither'lı).
- `compare_reference`: referans görselle siluet IoU'su, en-boy oranı ve bant bazında genişlik farkı,
  overlay görseli. `project_reference`: referansı görünür ve örtülmemiş texel'lere yansıtır.
- `record_build`: her düzenlemede sabit kameradan kare alır, sonda animasyonlu GIF yazar.
- Düzeltme: `add_mesh_primitive` silindir, koni, piramit, torus ve plane'i içi dışına dönük
  üretiyordu; extrude bu yüzden içeri gidiyordu. 4'ten fazla kenarlı silindir ve koni kapakları
  (n-gen) da hata veriyordu, artık üçgen fan olarak üretiliyor.

## 1.5.0 — Pixel art export

- `render_pixel_art`, `export_pixel_sprites`, `pixel_art_presets` eklendi.
- Texel hizalı ortografik kadraj (`scale_snap: texel`), 2-4x süper örnekleme ve mode filtresi.
  Ara renk üretilmez, alfa 0 ya da 255.
- Cel gölgeleme (2-5 bant) ve hue shift Oklab'da hesaplanır: gölge koyu ve soğuk, ışık açık ve sıcak.
  Alternatif olarak `shading: blockbench` ya da `flat`.
- Seçici kontur (`outline: outer`) ve iç çizgiler (`inner_lines: depth+parts`). İç çizgiler derinlik
  kırıklarında ve iki farklı kemiğin birleştiği yerde çizilir.
- Paletler: modelin kendi renkleri (`source`), `auto` + `max_colors`, sabit paletler (`pico8`,
  `sweetie16`, `endesga32`, `db32`, `aap64`, `resurrect64`, `apollo`) ya da hex listesi. Bayer 2/4/8
  dither seçeneği var, konturlar dither'lanmaz.
- Temizlik: yüzen tek pikseller silinir, kontur köşelerine pixel-perfect L kuralı uygulanır,
  `alpha_bleed` filtreleme yapan motorlarda koyu saçağı önler.
- Sprite sheet çıktısı Aseprite hash/array JSON'u ile uyumlu (`frameTags`, pivot `slices`). İsteğe bağlı
  tek tek kare PNG'leri ve görünüm uzayı normal haritası üretilir.

## 1.4.0 — Blockbench 5.2 entegrasyonu

- `texture_layers`: katmanlar ve katman grupları. `paint_texture` / `paint_faces` için `layer` parametresi.
  Boyama artık katman offset'ini hesaba katıyor. `resize_texture` tüm katmanları ölçekliyor.
- `add_ik_controllers` (pole desteğiyle) ve `bake_ik_animation`.
- `preview_models`: hareket ettirilebilir referans modeller. `reference_images`: sahnede 3D panel olarak
  gösterilen referans görseller.
- `add_mesh_primitive`: `icosphere`, `octahedron`, `dodecahedron`.
- Java 26.3 `shade_direction_override`, cushion skin şablonu, Molang `variable_placeholders`,
  `add_bounding_boxes`, `embedded` / `on_shelf` display slotları, glTF `merge_armature`.

## 1.3.0 — Saha düzeltmeleri

- `eval_code` artık Blockbench'i kilitleyemez. Blockbench, izin verilmeyen modüller için senkron bir
  izin penceresi açıyordu. Pencere küçültülmüşse bu kutu görünmüyordu ve uygulama donmuş gibi kalıyordu.
  Bu tür `require` çağrıları artık kod çalışmadan önce reddediliyor. Gerekirse
  `allow_native_modules: true` ile açılabilir.
- `eval_code` üst seviyede `return` ve `await` kabul ediyor.
- `get_status` ve `get_project_info` dosya yollarını ve son kullanılan klasörleri döndürüyor.
- Küp içermeyen bir gruba boyama yapılınca hata mesajı, içinde küp olan grupları listeliyor.
  Tüm model için `element: "*"` kullanılabilir.
- `set_keyframes` FPS ızgarasına yuvarlanan zamanları `snapped` altında bildiriyor. Tam zaman için
  `snap: false` kullanılabilir. Retime ve silme işlemleri için `edit_keyframes` eklendi.
  `update_animation` artık animasyonu kısaltabiliyor.
- Kemiğin rest rotasyonu varsa `set_keyframes` bunu bildiriyor, çünkü keyframe değerleri mutlak açı
  değil, rest rotasyonuna eklenen farktır.
- `get_texture` tek bir yüzün UV bölgesini kırpıp büyütebiliyor.

## 1.2.0 — Texture boyama

- Toplu hedefleme (`target: {element: "<grup>", faces: "all"}`), çok duraklı gradyan (`stops`),
  `space: "world"`, `strands` ve `noise` op'ları, `inspect_uv`.
