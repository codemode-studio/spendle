use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &str = r#"
export interface PdfTextItem {
  text: string;
  /** 1-indexed page number. */
  page: number;
  /** PDF points from the page's lower-left corner, `y` growing upward. */
  x: number;
  y: number;
  width: number;
  height: number;
  itemType: "Text" | "Image" | "Link" | "FormField";
}

export interface PdfRead {
  text: string;
  items: PdfTextItem[];
  /** 0-indexed pages whose text is an image or unreliable. */
  pagesNeedingOcr: number[];
}
"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextItem {
    text: String,
    page: u32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    item_type: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfRead {
    text: String,
    items: Vec<TextItem>,
    pages_needing_ocr: Vec<u32>,
}

fn item_type(item_type: &pdf_inspector::types::ItemType) -> &'static str {
    use pdf_inspector::types::ItemType;
    match item_type {
        ItemType::Text => "Text",
        ItemType::Image => "Image",
        ItemType::Link(_) => "Link",
        ItemType::FormField => "FormField",
    }
}

fn read(bytes: &[u8]) -> Result<PdfRead, pdf_inspector::PdfError> {
    let classification = pdf_inspector::classify_pdf_mem(bytes)?;
    let text = pdf_inspector::extractor::extract_text_mem(bytes)?;
    let items = pdf_inspector::extract_text_with_positions_mem(bytes)?
        .into_iter()
        .map(|item| TextItem {
            item_type: item_type(&item.item_type),
            text: item.text,
            page: item.page,
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
        })
        .collect();
    Ok(PdfRead {
        text,
        items,
        pages_needing_ocr: classification.pages_needing_ocr,
    })
}

// The glue's `__wbg_reset_state` calls the module's start function, which
// exists only when the crate declares one.
#[wasm_bindgen(start)]
fn start() {}

/// Reads a PDF's plain text, its text fragments with their positions and the
/// pages that need OCR, in one pass over the bytes.
#[wasm_bindgen(js_name = readPdf, unchecked_return_type = "PdfRead")]
pub fn read_pdf(bytes: &[u8]) -> Result<JsValue, JsError> {
    let read = read(bytes).map_err(|error| JsError::new(&error.to_string()))?;
    Ok(serde_wasm_bindgen::to_value(&read)?)
}
