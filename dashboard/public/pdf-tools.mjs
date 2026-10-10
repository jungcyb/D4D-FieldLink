import {getDocument,GlobalWorkerOptions} from '/vendor/pdfjs/pdf.min.mjs';
GlobalWorkerOptions.workerSrc='/vendor/pdfjs/pdf.worker.min.mjs';
/** Render a bounded selected page range entirely in the browser; no cloud converter. */
export async function pdfPageImages(file,firstPage=1,lastPage=2){
  const document=await getDocument({data:new Uint8Array(await file.arrayBuffer()),cMapUrl:'/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/standard_fonts/',wasmUrl:'/vendor/pdfjs/wasm/',iccUrl:'/vendor/pdfjs/iccs/',isEvalSupported:false}).promise;
  const files=[];
  try{if(firstPage>document.numPages)throw Error(`PDF는 ${document.numPages}페이지입니다.`);
    for(let number=firstPage;number<=Math.min(lastPage,document.numPages);number++){
      const page=await document.getPage(number),base=page.getViewport({scale:1}),scale=Math.min(1600/base.width,1600/base.height,2),viewport=page.getViewport({scale}),canvas=window.document.createElement('canvas');
      canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('PDF 페이지 이미지 생성 실패');
      files.push(new File([blob],`${file.name}__page-${number}.png`,{type:'image/png'}));page.cleanup();canvas.width=0;canvas.height=0;
    }return files;
  }finally{await document.destroy();}
}
