"""Build an RTL OOXML methodology document; requires python-docx only for documentation."""
import json,re,subprocess
from pathlib import Path
from docx import Document
from docx.shared import Inches,Pt,RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
ROOT=Path(__file__).resolve().parents[1]
subprocess.run(['node',str(ROOT/'scripts/export-methodology.js')],check=True)
registry=json.loads((ROOT/'docs/indicator-registry.json').read_text())
intro=(ROOT/'docs/methodology-intro.md').read_text()
doc=Document()
section=doc.sections[0]; section.page_height=Inches(11.7);section.page_width=Inches(8.3)
section.top_margin=section.bottom_margin=Inches(.7);section.left_margin=section.right_margin=Inches(.7)
normal=doc.styles['Normal'];normal.font.name='DejaVu Sans';normal.font.size=Pt(10)
normal.paragraph_format.space_after=Pt(6)
normal.paragraph_format.line_spacing=1.2
for key in ['Title','Heading 1','Heading 2','Heading 3']:
    doc.styles[key].font.name='DejaVu Sans';doc.styles[key].font.color.rgb=RGBColor.from_string('125C68')
    doc.styles[key].paragraph_format.keep_with_next=True

def rtl(p,yes=True):
    prop=OxmlElement('w:bidi');prop.set(qn('w:val'),'1' if yes else '0');p._p.get_or_add_pPr().append(prop)
    p.alignment=2 if yes else 0
    return p

def para(text,style=None,code=False):
    p=rtl(doc.add_paragraph(style=style),not code)
    r=p.add_run(text)
    if code:
        r.font.name='DejaVu Sans Mono';r.font.size=Pt(8)
    else:
        lang=OxmlElement('w:lang');lang.set(qn('w:bidi'),'fa-IR');r._r.get_or_add_rPr().append(lang)
    return p

header=rtl(section.header.paragraphs[0]);header.text='نـما  /  مسیر داده و متد محاسبه  /  نسخهٔ '+registry['version']
header.runs[0].font.size=Pt(8)
footer=rtl(section.footer.paragraphs[0]);footer.add_run('سند فنی — بستهٔ اجرایی بدون دادهٔ ورودی  |  صفحهٔ ')
field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');footer._p.append(field)
for block in intro.split('\n\n'):
    block=block.strip()
    if not block:continue
    if block.startswith('# '):para(block[2:],'Title')
    elif block.startswith('## '):para(block[3:],'Heading 1')
    else:para(block)
md=[intro]
labels={'flags':'پرچم‌ها و شاخص‌های کنترلی','metrics':'شاخص‌های عددی','categories':'دسته‌بندی‌ها','counters':'شمارنده‌های تجمیعی'}
for bank in registry['banks']:
    doc.add_page_break(); title='فهرست کامل بانک '+bank['label'];para(title,'Heading 1');md.append('\n# '+title)
    para('ریشهٔ c در فرمول‌ها:');para(bank['schema']['root'],code=True)
    md.append('ریشهٔ داده: `'+bank['schema']['root']+'`')
    para('مسیرهای قطعی','Heading 2');md.append('\n## مسیرهای قطعی')
    for field,fa in [('rotbe','رتبه‌بندی'),('facilities','تسهیلات'),('cheques','چک'),('loans','سابقهٔ وام'),('deposit','سپرده')]:
        para(fa,'Heading 3');para(bank['schema'][field],code=True);md.append(f'- {fa}: `{bank["schema"][field]}`')
    for group,title in labels.items():
        if not bank['definitions'][group]:continue
        para(title,'Heading 2');md.append('\n## '+title)
        for spec in bank['definitions'][group]:
            para(spec['label'],'Heading 3');md.append('\n### '+spec['label'])
            para(spec['id']+'  /  '+spec['topic'],code=True)
            para(spec['source'],code=True);md.append('مسیر: `'+spec['source']+'`')
            para('متد: '+spec['formula']);md.append('متد: '+spec['formula'])
            if group=='flags':
                note='فهرست نیازمند بررسی: '+('بله' if spec['inspect'] else 'خیر؛ شمارش حفظ می‌شود')+'؛ روند روزانه: '+('بله' if spec['daily'] else 'خیر')
                para(note);md.append(note)
            if spec['onlyStatus']!='ALL':
                para('دامنهٔ اختصاصی: '+spec['onlyStatus']);md.append('دامنه: '+spec['onlyStatus'])
            if spec.get('categories'):
                for key,value in spec['categories'].items():
                    para(str(key)+' : '+value);md.append('- '+str(key)+' : '+value)
            if spec.get('histogram'):
                hist=spec['histogram']
                para('توزیع طبق حدود تعریف‌شده؛ قرارداد مرزها در فصل ۴. جزئیات ماشین‌خوان در indicator-registry.json.')
                if 'edges' in hist:para('edges = '+json.dumps(hist['edges'],ensure_ascii=False),code=True)
                if 'bins' in hist:
                    for b in hist['bins']:
                        limits='value='+str(b['value']) if 'value' in b else f"min={b.get('min')}; max={b.get('max')}; includeMax={b.get('includeMax',False)}; excludeMin={b.get('excludeMin',False)}"
                        para(b['label']);para(limits,code=True)
    para('فهرست‌های ویژهٔ بانک','Heading 2')
    for spec in bank['lists']:
        para(spec['title'],'Heading 3');para('شرط اجرایی:');para(spec['filter'],code=True)
        md.append('\n### '+spec['title']+'\nشرط: `'+spec['filter']+'`')
# Prevent table/paragraph orphaning on small headings; standard document metadata.
doc.core_properties.title='متد محاسبه و مسیرهای دادهٔ داشبورد نـما'
doc.core_properties.subject='تعریف شاخص‌ها و مسیرهای قطعی سه بانک — نسخهٔ '+registry['version']
doc.core_properties.author='نـما — مستندات فنی'
doc.save(ROOT/'docs/methodology-fa.docx')
(ROOT/'docs/methodology-fa.md').write_text('\n\n'.join(md)+'\n')
print('Wrote methodology-fa.docx and methodology-fa.md')
