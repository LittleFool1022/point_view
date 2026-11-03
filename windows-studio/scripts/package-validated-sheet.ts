import {readFile,writeFile} from 'node:fs/promises';
import {createSurveyDelivery} from '../src/domain/delivery';
const root='artifacts/cad-sheet-20261029/real-20m',model=JSON.parse(await readFile(root+'/A1-model.json','utf8')),result=JSON.parse(await readFile(root+'/result.json','utf8')),html=await readFile(root+'/sheet.html','utf8'),pdf=await readFile(root+'/native-sheet.pdf');
const source={name:model.sourceName,native:{token:'validated-source',name:model.sourceName,size:result.sourceBytes,sha256:result.sourceSha256},units:'m' as const,synthetic:false};
const bundle=await createSurveyDelivery(model,source,async document=>{if(document.html!==html)throw Error('PDF 与当前排版不一致。');return pdf.buffer.slice(pdf.byteOffset,pdf.byteOffset+pdf.byteLength);});
await writeFile(root+'/A1-review-with-PDF.zip',bundle.archive);console.log(JSON.stringify({files:bundle.plot,pdfBytes:pdf.length}));
