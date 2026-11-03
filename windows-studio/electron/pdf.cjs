const { BrowserWindow } = require('electron');
const {PDFDocument}=require('pdf-lib');
/** 独立无脚本窗口，仅把本地矢量图纸转换为 PDF；不会调用实体打印机。 */
async function renderSheetPdf(document) {
  const { html,widthMm,heightMm }=document??{};
  if(typeof html!=='string'||Buffer.byteLength(html)>32*1024**2||![widthMm,heightMm].every(v=>Number.isFinite(v)&&v>=50&&v<=2000))throw Error('图纸打印数据无效。');
  const preview=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:false,backgroundThrottling:false}});
  preview.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  preview.webContents.on('will-navigate',event=>event.preventDefault());
  try {
    await preview.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    const raw=await preview.webContents.printToPDF({printBackground:true,displayHeaderFooter:false,preferCSSPageSize:true,scale:1,pageSize:{width:widthMm/25.4,height:heightMm/25.4},margins:{top:0,bottom:0,left:0,right:0}});
    const pdf=await PDFDocument.load(raw);
    if(pdf.getPageCount()!==1)throw Error('图纸应为单页，请检查图幅及打印内容。');
    const page=pdf.getPage(0),oldHeight=page.getHeight(),widthPt=widthMm*72/25.4,heightPt=heightMm*72/25.4;
    // Chromium 会按内部像素取整页面；只修正页面框和原点，不缩放图元与文字。
    page.setMediaBox(0,0,widthPt,heightPt);page.setCropBox(0,0,widthPt,heightPt);
    page.translateContent(0,heightPt-oldHeight);
    return Buffer.from(await pdf.save());
  } finally {if(!preview.isDestroyed())preview.destroy();}
}
module.exports={renderSheetPdf};
