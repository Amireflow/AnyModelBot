export default {
  "eyebrow": "FİYATLAR · KULLANDIKÇA ÖDE",
  "h2mark": "Abonelik yok",
  "h2rest": ". Yalnızca kullandığın kadar öde.",
  "lead": "AnyModelBot ücretsiz ve açık kaynak — abonelik yok, kademe yok. Model kullanımı Modelflare tarafından token başına ücretlendirilir ve fiyat listesi tamamen açıktır.",
  "source": "Fiyatlar modelflare.dev/pricing adresinden, {fetchedAt} (UTC+8) tarihinde alındı, sürüm {pricingVersion}.",
  "stale": "{snapshotDate} tarihli fiyat anlığı (yenilenemedi; asıl kaynak modelflare.dev/pricing).",
  "cards": {
    "app": {
      "tag": "AnyModelBot",
      "price": "$0",
      "unit": "/ sonsuza dek",
      "note": "Ücretsiz ve açık kaynak (MIT)",
      "points": [
        "Masaüstü, Docker ve CLI ücretsiz",
        "Abonelik yok, plan kademesi yok",
        "İstediğin kadar bot oluştur, her birini sen tanımlarsın",
        "Yeni Modelflare hesaplarına $1 bot kredisi; yalnızca AnyModelBot’da geçerli"
      ]
    },
    "usage": {
      "tag": "Model kullanımı · Modelflare faturalandırır",
      "unit": "/ 1M giriş tokeni",
      "note": "ör. {model}, varsayılan rota, 1M token başına çıkış {output}; resmi {officialIn} / {officialOut}",
      "points": [
        "Token başına fiyat, giriş ve çıkış ayrı",
        "Açık fiyat listesi",
        "Modeli istediğin zaman değiştir; fiyat modele uyar",
        "Modelflare abonelikleri, planın %10’u kadar bot kredisi ekler"
      ],
      "cta": "Tüm fiyat listesini gör ↗"
    },
    "month": {
      "tag": "Tahmini aylık kullanım",
      "unit": "/ ay",
      "note": "Örnek: günde 50 mesaj, her biri 3.000 giriş + 600 çıkış tokeni, {model}.",
      "points": [
        "Kendi kullanımını aşağıdaki hesap makinesine gir",
        "Tahmin, önbellek indirimlerini ve özel istek çarpanlarını içermez",
        "Modelflare faturası asıl kaynaktır"
      ],
      "cta": "Hesap makinesini aç"
    }
  },
  "contrast": {
    "caption": "Kullandıkça öde ile abonelik kademelerinin karşılaştırması",
    "head": [
      "",
      "Kullandıkça öde (AnyModelBot + Modelflare)",
      "Abonelik kademeleri (yaygın yaklaşım)"
    ],
    "rows": [
      [
        "Nasıl ücretlendirilir",
        "Kullandığın kadar ödersin, abonelik yok",
        "Abonelik ücreti ödersin; kademe ne kadar kullanabileceğini belirler"
      ],
      [
        "Kullanılmayan kısım",
        "Sabit gider yok",
        "Ayın hakkı genelde devretmez"
      ],
      [
        "Model değiştirme",
        "İstediğin zaman; fiyat modele uyar",
        "Kullanılabilir modeller genelde kademeyle sınırlıdır"
      ],
      [
        "Fiyatlar nasıl okunur",
        "1M token başına ücretler, açıkça listelenir",
        "Çoğu zaman bir hakkın katları olarak yazılır"
      ]
    ],
    "note": "“Abonelik kademeleri”, abonelik ücretli ürünlerin yaygın yaklaşımını anlatır; belirli bir ürünü veya gerçek fiyatlarını değil."
  },
  "table": {
    "more": "Tüm {textCount} metin modelinin fiyatlarını gör →",
    "caption": "Modelflare metin modeli fiyatları (varsayılan rota, 1M token başına USD)",
    "col": {
      "model": "Model",
      "route": "Varsayılan rota",
      "input": "Giriş / 1M",
      "output": "Çıkış / 1M",
      "official": "Resmi (giriş / çıkış)",
      "vs": "vs resmi"
    },
    "default": "Varsayılan",
    "context": "{n} bağlam",
    "showAll": "Tüm {textCount} metin modelini göster",
    "showFeatured": "Yalnızca öne çıkanlar",
    "search": "Model ara",
    "allVendors": "Tüm sağlayıcılar",
    "media": "Görsel ve video modelleri ({mediaCount}) modelflare.dev/pricing adresinde ↗",
    "expand": "{model} için tüm rotaları göster",
    "detail": {
      "route": "Rota",
      "positioning": "Konum",
      "vs": "vs resmi",
      "price": "Giriş / çıkış"
    },
    "positioning": {
      "stable": "Yüksek kararlılık rotası",
      "award": "Fiyat öncelikli rota",
      "campaign": "Süreli rota",
      "enterprise": "Yüksek kararlılık rotası (yalnızca yetkili kurumsal üretim)",
      "other": "Diğer rota"
    },
    "unlock": "Tek seferde US${amount} bakiye yüklemesiyle açılır (süreli; Modelflare kuralları geçerlidir)",
    "tiers": "{n} token üzerindeki tek istekler uzun bağlam kademesini kullanır: giriş {input} · çıkış {output}",
    "none": "Eşleşen model yok.",
    "note": "Fiyatlar varsayılan rota için 1M token başına USD’dir; hesabının erişimi veya indirimi farklı olabilir (Modelflare sayfasının belirttiği gibi). Veriler modelflare.dev/pricing adresinden, {fetchedAt} (UTC+8) tarihinde alındı, sürüm {pricingVersion}."
  },
  "calc": {
    "title": "Aylık maliyetini tahmin et",
    "model": "Model",
    "search": "Model aramak için yaz",
    "none": "Eşleşen model yok.",
    "route": "Rota",
    "routeDefault": "Varsayılan rota",
    "routeAward": "Fiyat öncelikli rota (award)",
    "routeAwardNote": "Yeniden denenebilir geliştirme ve test için uygun",
    "msgs": "Günde mesaj",
    "inTok": "Mesaj başına giriş tokeni",
    "inTokNote": "Sohbet geçmişi ve araç sonuçları dahil",
    "outTok": "Mesaj başına çıkış tokeni",
    "days": "30 gün üzerinden tahmin",
    "presets": {
      "light": "Hafif",
      "everyday": "Günlük",
      "heavy": "Yoğun (ajan)"
    },
    "hint": "Bir mesaj = bir bot yanıtının arkasındaki tüm model çağrıları; bir ajan görevi birkaç çağrı içerebilir.",
    "result": "≈ {amount} / ay",
    "split": "giriş {input} · çıkış {output}",
    "perMsg": "mesaj başına yaklaşık {amount}",
    "official": "resmi fiyatlarla yaklaşık {amount}",
    "disclaimer": "Yalnızca tahmindir. Önbellek indirimleri ve istek düzeyi çarpanlar (ör. öncelikli hizmet kademesi) hariçtir; bir modelin kademe eşiğini aşan istekler daha yüksek kademeden ücretlendirilir (dahil); Modelflare faturası asıl kaynaktır.",
    "copy": "Tahmini kopyala",
    "copyText": "AnyModelBot kullanım tahmini: {model} ({route}), günde {msgs} mesaj, her biri {inTok} giriş + {outTok} çıkış tokeni — ayda yaklaşık {amount} (30 gün, fiyatlar {fetchedAt} tarihinde alındı)",
    "full": "Bu modelin tüm fiyatlarını gör ↗",
    "expandBar": "Ayrıntılar"
  },
  "banner": {
    "text": "Modelflare hesabın var mı? Uygulamada bir kez oturum aç ve başla — kullanım fiyat listesine göre ücretlendirilir.",
    "cta": "Modelflare’i aç ↗"
  },
  "pageTitle": "AnyModelBot fiyatları — kullandıkça öde, açık fiyat listesi",
  "pageDescription": "AnyModelBot ücretsiz ve açık kaynak, abonelik yok. Model kullanımı Modelflare tarafından token başına ücretlendirilir: açık fiyat listesi ve aylık maliyet hesaplayıcısı."
};
