export default {
  "title": "Güvenlik — AnyModelBot",
  "description": "AnyModelBot verisi nereye gider, yerel korumalar ve bilinen sınırlar: cihazda kalan ve çıkmak zorunda olan.",
  "h1": "Güvenlik",
  "lead": "Ana sayfadaki veri akışı şemasının uzun hali: cihazda kalan, çıkmak zorunda olan, kodda doğrulayabileceğin korumalar ve vermediğimiz sözler.",
  "stays": "Cihazında kalır",
  "leaves": "Cihazından çıkar",
  "leavesItems": [
    "Modele gönderdiğin her şey (bilgisayar kullanımı sırasındaki ekran içeriği dahil) Modelflare ağ geçidinden seçtiğin sağlayıcıya gider.",
    "Modelflare, “Veri saklama” belgesine göre istek günlüklerini bir saklama süresi boyunca tutar (profilinde 7–365 gün seçebilirsin); bir istek sonunda başarısız olursa ya da bir yedek yol tutmadan önce bir rota düşerse, ağ geçidi sorun giderme için ham isteğin bir kopyasını (Authorization başlığı olmadan) saklar ve 72 saat sonra siler (aynı belge).",
    "Slack, Telegram ve Discord mesajları doğası gereği bu platformların sunucularından geçer.",
    "Notion veya GitHub gibi uygulamalar bağlarsan ya da özel bir MCP bağlayıcısı eklersen, botların okuyup yazdığı şey bu hizmetlere gider; okudukları da model isteklerine girer.",
    "Kurulu masaüstü uygulamaları açılıştan sonra ve her 6 saatte bir GitHub'da güncelleme arar ve güncelleme dosyalarını varsayılan olarak arka planda indirir. Otomatik indirmeyi Ayarlar → Genel'den kapatabilirsin. İsteklerde hesap bilgisi veya sohbet içeriği yoktur. Kurulum için çalışan görev yokken Yeniden başlat ve güncelle'ye basman gerekir.",
    "Uygulamanın İstekler ve Geri Bildirim penceresinden gönderdiğinde yazdıkların, seçtiğin kategori ve eklediğin bilgiler, sürüm ve sistem bilgileri, eklemeyi seçtiğin hata ve günlükler (anahtarlar *** ile değiştirilmiş) modelflare.dev'e, Modelflare hesabında özel bir destek talebi olarak gider. İletişim bilgileri yalnızca onay kutusunu işaretlersen eklenir. Göndermeden önce her şeyi görebilirsin; sohbetler ve ekran görüntüleri asla eklenmez."
  ],
  "guardsTitle": "Koddaki korumalar",
  "limitsTitle": "Sınırlar ve vermediğimiz sözler",
  "limits": [
    "Çevrimdışı veya yerel model yok; çıkarım istekleri her zaman cihazından çıkar.",
    "Bilgisayar kullanımı varsayılan olarak otomatik çalışır (arayüzü değiştiren eylemlerden önce sormaya çevrilebilir); macOS doğrudan modu gerçek makinelerde doğrulanmadı.",
    "Uygulamanın ağ davranışı üçüncü tarafça denetlenmedi, bu yüzden “sıfır telemetri” demiyoruz.",
    "Linux dışındaki platformlarda bubblewrap katmanı yok; sanal alanın gücü platforma göre değişir."
  ],
  "report": "Bir açık mı buldun? {email} adresine yaz."
};
