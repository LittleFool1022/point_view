/**
 * 独立 DXF 读取器回读：用 ezdxf 读取导出件，核对单位、原生标注测量值与中文，
 * 并写出与图纸 model.json 的逐项偏差。不是目标 CAD 软件验收。
 *
 * 用法（需要能 `import ezdxf` 的 Python，建议独立 venv）：
 *   DXF_READBACK_PYTHON=/path/to/venv/bin/python npx vite-node scripts/readback-dxf.ts -- <drawing.dxf> <drawing.json> <report.json>
 */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';

const [dxfPath,modelPath,reportPath]=process.argv.slice(2);
if(!dxfPath||!modelPath||!reportPath){
  console.error('用法：npx vite-node scripts/readback-dxf.ts -- <drawing.dxf> <drawing.json> <report.json>');
  process.exit(2);
}
const python=`import json,sys,math,re
import ezdxf
dxf_path,model_path,report_path=sys.argv[1],sys.argv[2],sys.argv[3]
doc=ezdxf.readfile(dxf_path)
auditor=doc.audit()
model=json.load(open(model_path,encoding='utf-8'))
msp=doc.modelspace()
def q(v): return round(float(v),6)
problems=[]
if doc.dxfversion!='AC1021': problems.append('DXF version %s, expected AC1021' % doc.dxfversion)
insunits=int(doc.header.get('$INSUNITS',0))
measurement=int(doc.header.get('$MEASUREMENT',0))
if insunits!=4: problems.append('$INSUNITS=%d, expected 4 (mm)' % insunits)
dims=list(msp.query('DIMENSION'))
by_id={}
for e in dims:
    ids=[v for code,v in e.get_xdata('POINTVIEW') if code==1000] if e.has_xdata('POINTVIEW') else []
    if ids: by_id[ids[0]]=q(e.get_measurement())
rows=[]
max_dev=0.0
for d in model.get('dimensions') or []:
    did=d['id']
    measured=by_id.get(did)
    s,e_=d['start'],d['end']
    length=math.hypot(e_[0]-s[0],e_[1]-s[1]) if d['kind']=='aligned' else (abs(e_[0]-s[0]) if d['kind']=='horizontal' else abs(e_[1]-s[1]))
    dev=None if measured is None else abs(measured-length)
    if measured is None: problems.append('missing native DIMENSION for %s' % did)
    else: max_dev=max(max_dev,dev)
    rows.append({'dimensionId':did,'kind':d['kind'],'expectedMm':q(length),'readbackMm':measured,'deviationMm':None if dev is None else q(dev)})
# This export escapes CJK per DXF convention as backslash-U+XXXX; decode before comparing.
pattern=re.compile(chr(92)+chr(92)+'U\\+([0-9A-Fa-f]{4})')
def decode(value):
    return pattern.sub(lambda m: chr(int(m.group(1),16)), value)
texts=[decode(t.dxf.text) for t in msp.query('TEXT')]
expected_texts=[e['text'] for e in model['entities'] if e['type']=='text' and any('\\u4e00'<=ch<='\\u9fff' for ch in e['text'])]
missing=[x for x in expected_texts if x not in texts]
chinese_preserved=not missing
if missing: problems.append('%d Chinese strings not preserved on readback' % len(missing))
result={
 'reader':'ezdxf %s' % ezdxf.__version__,
 'audit':{'errors':len(auditor.errors),'fixes':len(auditor.fixes)},
 'dxfVersion':doc.dxfversion,'insunits':insunits,'unitsMm':insunits==4,'measurement':measurement,
 'dimensionCount':len(dims),'expectedDimensionCount':len(model.get('dimensions') or []),
 'maxExportDeviationMm':q(max_dev),
 'dimensions':rows,
 'texts':len(texts),'chinesePreserved':chinese_preserved,
 'modelUnits':'mm','toleranceMm':1e-6,
 'problems':problems,
}
json.dump(result,open(report_path,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
print(json.dumps({k:result[k] for k in ('reader','audit','dxfVersion','unitsMm','dimensionCount','maxExportDeviationMm','chinesePreserved','problems')},ensure_ascii=False))
sys.exit(1 if problems else 0)
`;
/** 允许通过 DXF_READBACK_PYTHON 指定带 ezdxf 的解释器；默认 PATH 中的 python3。 */
const pythonBin=process.env.DXF_READBACK_PYTHON||'python3';
try{
  const output=execFileSync(pythonBin,['-c',python,dxfPath,modelPath,reportPath],{encoding:'utf-8',stdio:['ignore','pipe','pipe']});
  console.log(output.trim());
  const json=JSON.parse(readFileSync(reportPath,'utf-8'));
  if(json.maxExportDeviationMm>1e-6)throw Error(`回读最大偏差 ${json.maxExportDeviationMm} mm 超过 1e-6 mm。`);
}catch(error){
  console.error(error instanceof Error?error.message:String(error));
  process.exit(1);
}
