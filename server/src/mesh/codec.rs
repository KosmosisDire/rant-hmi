//! Rant messages to JSON and back, driven by the schema the mesh reported, so the HMI needs
//! no compiled types. Fields go by the paths Rant reads: `pose.position.x`, `boxes[2].min.x`.

use rant::{Field, FieldType, FieldView, MessageBuilder, Schema};
use serde_json::{Map, Number, Value, json};

use crate::protocol::{FieldInfo, FieldKind, TypeInfo};

/// A schema field with its members, built from Rant's flat depth first table.
#[derive(Clone, Debug)]
pub struct Shape {
    pub field: Field,
    pub options: Vec<String>,
    pub members: Vec<Shape>,
}

/// The schema as a tree. A bare type, such as a plain f64, is one shape with no name.
pub fn shapes(schema: &Schema) -> Vec<Shape> {
    let fields = schema.fields();
    let mut at = 0;
    level(schema, &fields, &mut at, 0)
}

fn level(schema: &Schema, fields: &[Field], at: &mut usize, depth: u16) -> Vec<Shape> {
    let mut out = Vec::new();
    while *at < fields.len() && fields[*at].depth == depth {
        let index = *at as u16;
        let field = fields[*at].clone();
        *at += 1;
        let options = match field.kind {
            FieldType::Enum => schema.enum_variants(index).into_iter().map(|v| v.name).collect(),
            _ => Vec::new(),
        };
        let members = level(schema, fields, at, depth + 1);
        out.push(Shape { field, options, members });
    }
    out
}

fn bare(shapes: &[Shape]) -> Option<&Shape> {
    match shapes {
        [one] if one.field.name.is_empty() => Some(one),
        _ => None,
    }
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() { name.to_owned() } else { format!("{prefix}.{name}") }
}

/// What a schema looks like to a screen.
pub fn type_info(schema: &Schema) -> TypeInfo {
    TypeInfo { name: schema.name(), fields: info(&shapes(schema)) }
}

fn info(shapes: &[Shape]) -> Vec<FieldInfo> {
    shapes
        .iter()
        .map(|s| {
            let array = matches!(s.field.kind, FieldType::Array | FieldType::VArray);
            FieldInfo {
                name: s.field.name.clone(),
                kind: kind(s.field.kind),
                type_name: s.field.type_name.clone(),
                elem: array.then(|| kind(s.field.elem)),
                count: if s.field.kind == FieldType::Array { s.field.count } else { 0 },
                options: s.options.clone(),
                members: info(&s.members),
            }
        })
        .collect()
}

fn kind(t: FieldType) -> FieldKind {
    use FieldType::*;
    match t {
        U8 => FieldKind::U8,
        U16 => FieldKind::U16,
        U32 => FieldKind::U32,
        U64 => FieldKind::U64,
        I8 => FieldKind::I8,
        I16 => FieldKind::I16,
        I32 => FieldKind::I32,
        I64 => FieldKind::I64,
        F32 => FieldKind::F32,
        F64 => FieldKind::F64,
        Bool => FieldKind::Bool,
        String | VString => FieldKind::String,
        Enum => FieldKind::Enum,
        Struct => FieldKind::Struct,
        Array | VArray => FieldKind::Array,
        Map => FieldKind::Map,
        _ => FieldKind::Unknown,
    }
}

/// A message as JSON. A field this cannot read yet, a map, reads as null.
pub fn decode(view: &FieldView, shapes: &[Shape]) -> Value {
    match bare(shapes) {
        Some(one) => read(view, one, ""),
        None => object(view, shapes, ""),
    }
}

/// The schema's default message, the start of a partial write with no value yet.
pub fn default_value(schema: &Schema, shapes: &[Shape]) -> Value {
    let message = MessageBuilder::new(schema);
    decode(&schema.view(message.bytes()), shapes)
}

fn object(view: &FieldView, shapes: &[Shape], prefix: &str) -> Value {
    let mut map = Map::new();
    for s in shapes {
        map.insert(s.field.name.clone(), read(view, s, &join(prefix, &s.field.name)));
    }
    Value::Object(map)
}

fn read(view: &FieldView, s: &Shape, path: &str) -> Value {
    use FieldType::*;
    match s.field.kind {
        U8 | U16 | U32 | U64 => json!(view.get_uint(path)),
        I8 | I16 | I32 | I64 => json!(view.get_int(path)),
        F32 => float(view.get_f32(path) as f64),
        F64 => float(view.get_f64(path)),
        Bool => json!(view.get_bool(path)),
        String | VString => json!(view.get_string(path)),
        Enum => view.get_enum_name(path).map_or_else(|| json!(view.get_int(path)), |n| json!(n)),
        Struct => object(view, &s.members, path),
        Array | VArray => list(view, s, path),
        _ => Value::Null,
    }
}

/// JSON has no NaN or infinity, so those read as null.
fn float(v: f64) -> Value {
    Number::from_f64(v).map_or(Value::Null, Value::Number)
}

fn list(view: &FieldView, s: &Shape, path: &str) -> Value {
    let count = view.get_array_count(path) as usize;
    let items = match s.field.elem {
        FieldType::Struct => (0..count).map(|i| object(view, &s.members, &format!("{path}[{i}]"))).collect(),
        FieldType::String | FieldType::VString => {
            (0..count).map(|i| json!(view.get_string_at(path, i as u16))).collect()
        }
        elem => match width(elem) {
            0 => return Value::Null,
            w => view.get_array(path).chunks_exact(w).map(|b| element(elem, b)).collect(),
        },
    };
    Value::Array(items)
}

fn width(t: FieldType) -> usize {
    use FieldType::*;
    match t {
        U8 | I8 | Bool => 1,
        U16 | I16 => 2,
        U32 | I32 | F32 => 4,
        U64 | I64 | F64 => 8,
        _ => 0,
    }
}

fn element(t: FieldType, b: &[u8]) -> Value {
    use FieldType::*;
    let bytes = |n: usize| -> [u8; 8] {
        let mut a = [0u8; 8];
        a[..n].copy_from_slice(&b[..n]);
        a
    };
    match t {
        U8 => json!(b[0]),
        I8 => json!(b[0] as i8),
        Bool => json!(b[0] != 0),
        U16 => json!(u16::from_le_bytes([b[0], b[1]])),
        I16 => json!(i16::from_le_bytes([b[0], b[1]])),
        U32 => json!(u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        I32 => json!(i32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        F32 => float(f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64),
        U64 => json!(u64::from_le_bytes(bytes(8))),
        I64 => json!(i64::from_le_bytes(bytes(8))),
        F64 => float(f64::from_le_bytes(bytes(8))),
        _ => Value::Null,
    }
}

/// A message from JSON. Fields the JSON leaves out keep the schema's defaults.
pub fn encode(schema: &Schema, shapes: &[Shape], value: &Value) -> Result<Vec<u8>, String> {
    let mut message = MessageBuilder::new(schema);
    match bare(shapes) {
        Some(one) => write(&mut message, one, "", value)?,
        None => members(&mut message, shapes, "", value)?,
    }
    Ok(message.bytes().to_vec())
}

fn label(path: &str) -> &str {
    if path.is_empty() { "the value" } else { path }
}

fn wants(path: &str, what: &str) -> String {
    format!("{} takes {what}", label(path))
}

fn members(m: &mut MessageBuilder, shapes: &[Shape], prefix: &str, value: &Value) -> Result<(), String> {
    let fields = value.as_object().ok_or_else(|| wants(prefix, "an object"))?;
    for s in shapes {
        if let Some(v) = fields.get(&s.field.name) {
            write(m, s, &join(prefix, &s.field.name), v)?;
        }
    }
    Ok(())
}

fn write(m: &mut MessageBuilder, s: &Shape, path: &str, v: &Value) -> Result<(), String> {
    use FieldType::*;
    let refused = |e: rant::Error| e.to_string();
    match s.field.kind {
        U8 | U16 | U32 | U64 => {
            m.set_uint(path, whole(v).filter(|n| *n >= 0).ok_or_else(|| wants(path, "a whole number of 0 or more"))? as u64)
                .map_err(refused)?;
        }
        I8 | I16 | I32 | I64 => {
            m.set_int(path, whole(v).ok_or_else(|| wants(path, "a whole number"))?).map_err(refused)?;
        }
        F32 => {
            m.set_f32(path, v.as_f64().ok_or_else(|| wants(path, "a number"))? as f32).map_err(refused)?;
        }
        F64 => {
            m.set_f64(path, v.as_f64().ok_or_else(|| wants(path, "a number"))?).map_err(refused)?;
        }
        Bool => {
            m.set_bool(path, v.as_bool().ok_or_else(|| wants(path, "true or false"))?).map_err(refused)?;
        }
        String | VString => {
            m.set_string(path, v.as_str().ok_or_else(|| wants(path, "text"))?).map_err(refused)?;
        }
        Enum => match v {
            Value::String(option) => {
                m.set_enum(path, option).map_err(refused)?;
            }
            other => {
                m.set_int(path, whole(other).ok_or_else(|| wants(path, "one of its options"))?).map_err(refused)?;
            }
        },
        Struct => members(m, &s.members, path, v)?,
        Array | VArray => write_list(m, s, path, v)?,
        _ => return Err(format!("{} cannot be written yet", label(path))),
    }
    Ok(())
}

/// A JSON number that is a whole number, whichever way JSON stored it.
fn whole(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
}

fn write_list(m: &mut MessageBuilder, s: &Shape, path: &str, v: &Value) -> Result<(), String> {
    let items = v.as_array().ok_or_else(|| wants(path, "a list"))?;
    let refused = |e: rant::Error| e.to_string();
    let variable = s.field.kind == FieldType::VArray;
    match s.field.elem {
        FieldType::Struct => {
            if variable {
                m.set_array_count(path, items.len() as u32).map_err(refused)?;
            }
            for (i, item) in items.iter().enumerate() {
                members(m, &s.members, &format!("{path}[{i}]"), item)?;
            }
        }
        FieldType::String | FieldType::VString => {
            if variable {
                m.set_array_count(path, items.len() as u32).map_err(refused)?;
            }
            for (i, item) in items.iter().enumerate() {
                let text = item.as_str().ok_or_else(|| wants(path, "a list of text"))?;
                m.set_string_at(path, i as u16, text).map_err(refused)?;
            }
        }
        elem => {
            let mut bytes = Vec::with_capacity(items.len() * width(elem));
            for item in items {
                push(&mut bytes, elem, item).ok_or_else(|| wants(path, "a list of numbers"))?;
            }
            m.set_array(path, &bytes).map_err(refused)?;
        }
    }
    Ok(())
}

fn push(out: &mut Vec<u8>, t: FieldType, v: &Value) -> Option<()> {
    use FieldType::*;
    match t {
        U8 => out.push(u8::try_from(whole(v)?).ok()?),
        I8 => out.push(i8::try_from(whole(v)?).ok()? as u8),
        Bool => out.push(v.as_bool()? as u8),
        U16 => out.extend(u16::try_from(whole(v)?).ok()?.to_le_bytes()),
        I16 => out.extend(i16::try_from(whole(v)?).ok()?.to_le_bytes()),
        U32 => out.extend(u32::try_from(whole(v)?).ok()?.to_le_bytes()),
        I32 => out.extend(i32::try_from(whole(v)?).ok()?.to_le_bytes()),
        U64 => out.extend(u64::try_from(whole(v)?).ok()?.to_le_bytes()),
        I64 => out.extend(whole(v)?.to_le_bytes()),
        F32 => out.extend((v.as_f64()? as f32).to_le_bytes()),
        F64 => out.extend(v.as_f64()?.to_le_bytes()),
        _ => return None,
    }
    Some(())
}

/// Puts `value` at a dotted field path inside `target`, for a write to one field.
pub fn put(target: &mut Value, path: &str, value: Value) -> Result<(), String> {
    let mut at = target;
    let mut parts = path.split('.').peekable();
    while let Some(part) = parts.next() {
        let fields = at.as_object_mut().ok_or_else(|| format!("{path} names no field"))?;
        if parts.peek().is_none() {
            if !fields.contains_key(part) {
                return Err(format!("{path} names no field"));
            }
            fields.insert(part.to_owned(), value);
            return Ok(());
        }
        at = fields.get_mut(part).ok_or_else(|| format!("{path} names no field"))?;
    }
    Err(format!("{path} names no field"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rant::{Node, NodeOptions};

    fn node() -> Node {
        Node::new("hmi_codec_test", NodeOptions::new().domain(152).multicast_interface("127.0.0.1")).unwrap()
    }

    fn round_trip(dsl: &str, value: Value) {
        let node = node();
        let schema = node.schema(dsl).unwrap();
        let shapes = shapes(&schema);
        let bytes = encode(&schema, &shapes, &value).unwrap();
        assert_eq!(decode(&schema.view(&bytes), &shapes), value, "{dsl}");
    }

    #[test]
    fn scalars_and_text() {
        round_trip(
            "Conveyor { speed: f64, running: bool, part: string<16>, count: u32, delta: i16, ratio: f32 }",
            json!({ "speed": 0.5, "running": true, "part": "A7", "count": 12, "delta": -3, "ratio": 0.25 }),
        );
    }

    #[test]
    fn a_bare_number() {
        round_trip("f64", json!(1.5));
    }

    #[test]
    fn nested_standard_types() {
        round_trip(
            "Arm { pose: Pose }",
            json!({ "pose": { "position": { "x": 1.0, "y": 2.0, "z": 3.0 },
                              "orientation": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 } } }),
        );
    }

    #[test]
    fn lists() {
        round_trip(
            "Lists { joints: f64[], fixed: f32[3], names: string<8>[], boxes: AlignedBox2D[] }",
            json!({ "joints": [0.5, -1.0], "fixed": [1.0, 2.0, 3.0], "names": ["a", "bc"],
                    "boxes": [ { "min": { "x": 0.0, "y": 1.0 }, "max": { "x": 2.0, "y": 3.0 } },
                               { "min": { "x": 4.0, "y": 5.0 }, "max": { "x": 6.0, "y": 7.0 } } ] }),
        );
    }

    #[test]
    fn enums_by_name() {
        round_trip("Line { mode: enum<u8> { Auto, Manual } }", json!({ "mode": "Manual" }));
    }

    #[test]
    fn a_missing_field_keeps_its_default() {
        let node = node();
        let schema = node.schema("Conveyor { speed: f64, running: bool }").unwrap();
        let shapes = shapes(&schema);
        let bytes = encode(&schema, &shapes, &json!({ "running": true })).unwrap();
        assert_eq!(decode(&schema.view(&bytes), &shapes), json!({ "speed": 0.0, "running": true }));
    }

    #[test]
    fn a_wrong_kind_is_refused_by_name() {
        let node = node();
        let schema = node.schema("Conveyor { speed: f64 }").unwrap();
        let err = encode(&schema, &shapes(&schema), &json!({ "speed": "fast" })).unwrap_err();
        assert_eq!(err, "speed takes a number");
    }

    #[test]
    fn put_sets_one_field() {
        let mut v = json!({ "a": { "b": 1 }, "c": 2 });
        put(&mut v, "a.b", json!(5)).unwrap();
        assert_eq!(v, json!({ "a": { "b": 5 }, "c": 2 }));
        assert!(put(&mut v, "a.x", json!(1)).is_err());
    }
}
