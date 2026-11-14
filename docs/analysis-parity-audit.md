# ممیزی کامل تطبیق تحلیل: نسخهٔ قدیمی در برابر نسخهٔ زنده

هدف: پیدا کردن دقیق محل اختلاف اعداد بین `report.html` قدیمی (نسخهٔ ۲٫۱۸) و داشبورد زنده (نسخهٔ ۰٫۱).

> نکتهٔ مهم: طبق PRD §1.3، کد `ce-dashboard/` داخل مخزن **یک کپی دستکاریشده** است؛
> یک جایگزینی متنی سراسری (`eDa`/`edA` ← `ce-dashboard`) روی بخشی از نامها اعمال شده.
> بنابراین مقایسهٔ «کپی من با کد مخزن» بهتنهایی کافی نیست؛ علاوه بر آن فرمولها با
> `docs/indicator-registry.json` (رجیستری مستند همان نسخه) و با تست A/B روی یک اسنپشاپ واحد چک شدند.

## ۱) هش تکتک فایلهای موتور تحلیل

| فایل | قدیمی | کپی بکاند | وضعیت |
|---|---|---|---|
| `banks/_helpers.js` | `6c4c818046da` | `6c4c818046da` | یکسان |
| `banks/_template.js` | `da13c8df9c8b` | `da13c8df9c8b` | یکسان |
| `banks/mellat.js` | `68005591589f` | `d125b861c941` | تغییر |
| `banks/postbank.js` | `f75592e309a0` | `60b4d494560b` | تغییر |
| `banks/resalat.js` | `228c86acfd9f` | `af63c15fbfc7` | تغییر |
| `src/analyze.js` | `05a36c1da960` | `2b6232888dcc` | تغییر |
| `src/banks.js` | `3008ed502e37` | `3008ed502e37` | یکسان |
| `src/charts.js` | `b0791920e0d5` | `b0791920e0d5` | یکسان |
| `src/common.js` | `b811e17f3071` | `b811e17f3071` | یکسان |
| `src/config.js` | `5a1b6d1d4f10` | `5a1b6d1d4f10` | یکسان |
| `src/credit-alerts.js` | `a3a80510c571` | `5dfe4e423270` | تغییر |
| `src/data-monitoring.js` | `2bcdb4a936e1` | `2d0cde0a6f76` | تغییر |
| `src/facilities.js` | `c88a751fd3af` | `c88a751fd3af` | یکسان |
| `src/facility-items.js` | `5fe133af2d8c` | `5fe133af2d8c` | یکسان |
| `src/loan-delays.js` | `30d264c9fb51` | `30d264c9fb51` | یکسان |
| `src/private.js` | `975401fe45f1` | `975401fe45f1` | یکسان |
| `src/render.js` | `96a8b6076e63` | `96a8b6076e63` | یکسان |
| `src/resalat-deposits.js` | `128ef132e53c` | `128ef132e53c` | یکسان |
| `src/scan.js` | `d87cba2d9df7` | `d87cba2d9df7` | یکسان |
| `src/schema.js` | `2c73b27102c7` | `2c73b27102c7` | یکسان |

فایلهای `legacy-report/`: `charts.js` و `_helpers.js` بایت به بایت یکسان؛
`render.js` و `common.js` فقط `require` و متنهای نمایشی/پیام خصوصی عوض شدهاند
(`quantile`, `metricsTable`, `histogram`, `nf`, `pct` دستنخوردهاند).

### شش فایل متفاوت، خط به خط

| فایل | تغییر | اثر روی اعداد جداول تجمیعی |
|---|---|---|
| `src/analyze.js` | `analyzeOne` به `createEvaluator` استخراج شد؛ `creditAlerts` از حلقهٔ `analyze()` به داخل ارزیاب منتقل شد | **هیچ** — بدنهٔ شاخصها، `newStats()`, `bump()`, `stampOf()`, `baseRow()` بدون تغییر |
| `banks/mellat.js` | اضافه شدن `diag` (شمارش هشدار تاریخ سپرده) + متن `extraHtml` | **هیچ** — فقط یک هشدار نمایشی |
| `banks/resalat.js`, `banks/postbank.js` | تعمیر `rotbce-dashboardta` → `rotbeData` (SyntaxError) | **هیچ روی ملت**؛ فقط بارگذاری دو بانک دیگر ممکن شد |
| `src/data-monitoring.js` | `approvce-dashboardmount` → `approvedAmount` | فقط فلگهای `loanApprovedZero/Null` (پستبانک)، نه `Credit_Basket/PD/total_time` |
| `src/credit-alerts.js` | `chequCEdashboardte` → `chequeDate` (تغییر نام تابع) | **هیچ** |

فرمولهای عددی طبق رجیستری مستند هم تأیید شدند:

```text
creditBasket : (_c, s) => num(get(s, 'output.Credit_Basket'))
pd           : (_c, s) => num(get(s, 'output.PD'))
totalTime    : (_c, s) => num(get(s, 'output.total_time'))
quantile     : (sorted.length-1)*q → درونیابی خطی؛ render.js:60
metricsTable : sort → min/p25/median/mean/p75/max؛ render.js:68
histogram    : مرزهای spec.hist، مقایسهٔ خام قبل از گرد کردن؛ render.js:98
```

## ۲) تست A/B روی یک اسنپشاپ واحد

```bash
cd backend
npm run test:ab-parity                      # ۱۲۰ نمونهٔ مصنوعی
node scripts/ab-parity.js /path/to/reports # پوشهٔ reports/ واقعی خودتان
```

یک پوشهٔ `reports/<day>/{success,fail}/*.json` یکبار از مسیر قدیمی
(`scan → analyzeOne → bump → buildHtml`) و یکبار از مسیر زنده
(`normalizeSample → evaluate → samples_* → consumeRow → bump → buildHtml`) رد میشود.
**هر دو از یک رندرر** استفاده میکنند، پس هر اختلافی فقط از `data` است.

نتیجه روی ۱۲۰ نمونه:

```json
{ "samples": 120, "tablesCompared": 85, "aggregateTableDiffs": [],
  "detailTableDiffs": 21, "identical": true, "differences": [] }
```

یعنی **همهٔ جداول تجمیعی/عددی (شاخصهای عددی، هیستوگرامها، سبد ردهها،
سرویسها، پیامها، کیفیت کلیدها) بایت به بایت یکساناند.** ۲۱ جدول «جزئیات» فقط
بهخاطر ترتیب ردیفها و ترتیب ستونها فرق دارند:

- دیتابیس ردیفها را بر `(day, stamp_key, request_id)` مرتب میکند، قدیمی به ترتیب فایلها؛
- ستون `display_extras` از نوع `jsonb` است و **ترتیب کلیدهای شیء را حفظ نمیکند**،
  برخلاف شیء سادهٔ JS قدیمی. نتیجه: در جدول جزئیات، `PD` قبل از `requestId` میآید؛
  و در سلول «نوع خالی بودن» ترتیب `آرایهٔ خالی / null` جابهجا میشود (اعداد هماناند).
- `rowsCap=100` باعث میشود ۱۰۰ ردیف نمایشدادهشده در دو خروجی متفاوت باشد،
  ولی شمارشها و آمار روی **همهٔ** ردیفها حساب میشوند.

## ۳) پس اختلاف اسکرینشاتها از کجاست؟

الگوی مشاهدهشده در عکسها (هم برای ۴٬۱۷۸ و هم ۴٬۰۹۷ رکورد):

| ستون | عکس چپ (زنده) | عکس راست (قدیمی) |
|---|---|---|
| کمینه / بیشینه / چارکاول / میانه / چارکسوم | یکسان | یکسان |
| میانگین `Credit_Basket` | ۹۷٬۲۸۱٬۴۲۵ / ۱۰۱٬۰۹۰٬۰۲۴ | ۹۷٬۰۱۰٬۲۵۱ / ۱۰۰٬۷۶۰٬۶۵۱ |
| میانگین PD | ۰٫۳۸۴۹ / ۰٫۳۸۸۱ | ۰٫۳۸۴۳ / ۰٫۳۸۸۵ |
| چند ردیف هیستوگرام | ۶۳۷ / ۶۳۸ / ۸۵۷ / ۵۵۶ / ۱٬۴۰۹ | ۶۳۲ / ۶۴۱ / ۸۵۴ / ۵۵۸ / ۱٬۴۱۲ |
| تعداد کل | ۴٬۰۹۷ | ۴٬۰۹۷ |

این **امضای اختلاف داده** است، نه اختلاف فرمول: اگر `quantile`، مرزهای بازه،
`num()` یا گردکردن عوض شده بود، `min/max/p25/p75` و همهٔ ردیفها بهصورت
سیستماتیک جابهجا میشدند. اینجا فقط آمارهای وابسته به **مجموع** (mean) و
ردیفهای نزدیک مرز بازهها تکان خوردهاند؛ یعنی تعداد کمی ردیف مقدار خام
متفاوتی داشتهاند. حتی `total_time` (زمان اجرای مدل، که مقدار ثابت گزارش است)
هم کمی فرق کرده → دو خوانش جداگانه از API.

علت معماری: نسخهٔ قدیمی **هر بار** از روی فایلهای خام `reports/*.json` دوباره
تحلیل میکند؛ نسخهٔ زنده شاخصها را **یکبار هنگام Ingestion** حساب میکند و در
`samples_*` ذخیره میکند و `/api/report` فقط مقادیر ذخیرهشده را `bump` میزند.
پس «همان روز» لزوماً «همان اسنپشاپ» نیست:

1. دو اجرا در زمانهای مختلف از API زنده خوانده شدهاند؛ مقادیر `output.*`
   (مخصوصاً `total_time`) میتوانند بین دو درخواست تفاوت جزئی داشته باشند.
2. صفحهبندی API پایدار نیست (PRD D-01): با `limit=50` ممکن است چند ردیف در
   مرز صفحات جابهجا/تکرار شوند. قدیمی تکراریها را دوبار مینویسد و میشمارد،
   دیتابیس با `ON CONFLICT (request_id)` آنها را یکی میکند.
3. `request_id` تکراری/تغییریافته → یکی شدن یا ردیف جدید.
4. ردیفهایی با `analysis_version` قدیمیتر (Ingestion با بیلد قبلی) هنوز در
   دیتابیساند، چون ری-ingest ردیفهای غایب را پاک نمیکند.

## ۴) چطور قطعی کنید

```bash
# ۱) همان فایلهای قدیمی را مستقیم وارد دیتابیس کنید (بدون خواندن دوبارهٔ API)
cd backend
node scripts/import-legacy-reports.js /path/to/reports tavan_mellat

# ۲) یا حداقل A/B را روی همان پوشه اجرا کنید
node scripts/ab-parity.js /path/to/reports

# ۳) سلامت نسخهها را ببینید
curl http://localhost:3001/api/diagnostics   # bankDiagnostics.*.analysisVersions

# ۴) اختیاری: آن روز را از صفر بسازید تا ردیفهای منسوخ/نسخهقدیمی پاک شوند
./ingest.sh --bank=tavan_mellat --day=1405-08-19 --rebuild
```

> `--rebuild` پیش از ورود، تمام ردیفهای `(bank, day)` و `day_runs` آن روز را حذف
> میکند و در یک تراکنش دوباره میسازد؛ `--day` اجباری است، پاسخ خالی API اجرا را
> پیش از حذف لغو میکند، و خرابی وسط کار `ROLLBACK` میشود. جزئیات در `README.md`
> بخش «`--rebuild` چیست و کی لازم است؟» و تست `npm run test:rebuild`.

اگر `ab-parity` روی پوشهٔ واقعی شما `identical: true` داد، اختلاف اسکرینشاتها
قطعاً از اسنپشاپ است. اگر `aggregateTableDiffs` غیرخالی داد، همان خروجی را
بفرستید تا دقیقاً همان جدول/ردیف را ریشهيابی کنیم.

## ۵) تفاوتهای باقیماندهٔ شناختهشده (غیرعددی)

| مورد | وضعیت |
|---|---|
| ترتیب ستونها/ردیفهای جدول جزئیات | تفاوت عمدیِ `jsonb` + مرتبسازی دیتابیس؛ اعداد یکیاند |
| پیام ناشناخته | قدیمی متن خام، زنده «سایر پیامها» (PRD §12 / D-05) |
| «فایلهای بررسیشده» ← «اجراهای پوششدادهشده» | قدیمی تعداد فایلها، زنده تعداد `day_runs` |
| `processedFiles` در A/B | ۲ فایل در برابر ۱ ردیف روز (صرفاً برچسب) |
| جزئیات نمونه | قدیمی فایل خصوصی `reports/_ce-dashboard-private`، زنده `/api/sample/{requestId}` |
