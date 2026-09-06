import test from "node:test";
import assert from "node:assert/strict";
import {createJiti} from "jiti";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
const jiti=createJiti(import.meta.url,{alias:{"@":root}});
const {collectSafePageBreaks}=jiti("./pdf-download.ts");

test("PDF pagination uses complete table rows instead of shorter adjacent-cell paragraphs",()=>{
 const row={tagName:"TR",closest:()=>null,getBoundingClientRect:()=>({bottom:1040})};
 const shortCellParagraph={tagName:"P",closest:()=>row,getBoundingClientRect:()=>({bottom:800})};
 const tallCellParagraph={tagName:"P",closest:()=>row,getBoundingClientRect:()=>({bottom:1020})};
 const heading={tagName:"H2",closest:()=>null,getBoundingClientRect:()=>({top:60,bottom:80})};
 const container={getBoundingClientRect:()=>({top:20}),querySelectorAll:()=>[heading,row,shortCellParagraph,tallCellParagraph]};
 assert.deepEqual(collectSafePageBreaks(container,2),[80,2040]);
});


test("PDF heading boundaries precede the heading instead of orphaning or clipping it", () => {
 const heading={tagName:"H2",closest:()=>null,getBoundingClientRect:()=>({top:1510,bottom:1535})};
 const paragraph={tagName:"P",closest:()=>null,getBoundingClientRect:()=>({top:1560,bottom:1650})};
 const container={getBoundingClientRect:()=>({top:0}),querySelectorAll:()=>[heading,paragraph]};
 assert.deepEqual(collectSafePageBreaks(container,1.5),[2265,2475]);
});
