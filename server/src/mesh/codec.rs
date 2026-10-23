//! Rant messages to values and back, driven by the schema the mesh reported, so the HMI needs
//! no compiled types. Fields go by the paths Rant reads: `pose.position.x`, `boxes[2].min.x`.

use rant::{Field, FieldType, FieldView, MessageBuilder, Schema};

use crate::protocol::{EnumInfo, FieldInfo, FieldKind, TypeInfo};
use crate::value::{Num, Numbers, Records, Value};

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

/// The names of the top level's fields, none for a bare type.
pub fn top_fields(shapes: &[Shape]) -> Vec<String> {
    if bare(shapes).is_some() { Vec::new() } else { shapes.iter().map(|s| s.field.name.clone()).collect() }
}

/// Adds each enum the shapes hold at any depth, unless one of that name is there: the named
/// ones, or the anonymous ones by their field's name, so named ones go first.
pub fn enums(shapes: &[Shape], anonymous: bool, out: &mut Vec<EnumInfo>) {
    for s in shapes {
        let named = s.field.type_name.as_deref().filter(|n| !n.is_empty());
        let name = match named {
            Some(n) if !anonymous => Some(n.to_owned()),
            // until Rant names every enum: drop this once it refuses anonymous ones
            None if anonymous => pascal(&s.field.name),
            _ => None,
        };
        if let Some(name) = name.filter(|n| s.field.kind == FieldType::Enum && !out.iter().any(|e| e.name == *n)) {
            out.push(EnumInfo { name, options: s.options.clone() });
        }
        enums(&s.members, anonymous, out);
    }
}

/// A field's name as a type's, `job_name` as `JobName`, or none when code could not name it.
fn pascal(field: &str) -> Option<String> {
    let mut name = String::new();
    for word in field.split('_') {
        let mut chars = word.chars();
        name.extend(chars.next().map(|c| c.to_ascii_uppercase()));
        name.extend(chars);
    }
    let usable = name.starts_with(|c: char| c.is_ascii_alphabetic()) && name.chars().all(|c| c.is_ascii_alphanumeric());
    usable.then_some(name)
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

/// A message as a value. A field this cannot read yet, a map, reads as null.
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
    Value::Map(shapes.iter().map(|s| (s.field.name.clone(), read(view, s, &join(prefix, &s.field.name)))).collect())
}

fn read(view: &FieldView, s: &Shape, path: &str) -> Value {
    use FieldType::*;
    match s.field.kind {
        U8 | U16 | U32 | U64 => view.get_uint(path).into(),
        I8 | I16 | I32 | I64 => view.get_int(path).into(),
        F32 => Value::Float(view.get_f32(path).into()),
        F64 => Value::Float(view.get_f64(path)),
        Bool => view.get_bool(path).into(),
        String | VString => view.get_string(path).into_owned().into(),
        Enum => view.get_enum_name(path).map_or_else(|| view.get_int(path).into(), Value::from),
        Struct => object(view, &s.members, path),
        Array | VArray => list(view, s, path),
        _ => Value::Null,
    }
}

fn list(view: &FieldView, s: &Shape, path: &str) -> Value {
    let count = view.get_array_count(path) as usize;
    match s.field.elem {
        FieldType::Struct => columns(view, s, path, count)
            .unwrap_or_else(|| Value::List((0..count).map(|i| object(view, &s.members, &format!("{path}[{i}]"))).collect())),
        FieldType::String | FieldType::VString => Value::List((0..count).map(|i| view.get_string_at(path, i as u16).into_owned().into()).collect()),
        // a list of bytes stays bytes, as an image's data is
        FieldType::U8 => Value::Bytes(view.get_array(path).to_vec()),
        elem => match (num(elem), width(elem)) {
            (Some(kind), _) => Numbers::new(kind, view.get_array(path)).map_or(Value::Null, Value::Numbers),
            (None, 0) => Value::Null,
            (None, w) => Value::List(view.get_array(path).chunks_exact(w).map(|b| element(elem, b)).collect()),
        },
    }
}

/// A list of records whose fields are all numbers, as columns cut from its packed bytes. None
/// for any other, which goes record by record.
fn columns(view: &FieldView, s: &Shape, path: &str, count: usize) -> Option<Value> {
    let (bytes, size) = (view.get_array(path), s.field.elem_size as usize);
    // the element is the same for every writer, as nested structs match exactly
    if size == 0 || bytes.len() != count * size {
        return None;
    }
    // members sit from a fixed array's own offset, and from 0 in a variable array's element
    let base = if s.field.kind == FieldType::Array { s.field.offset } else { 0 };
    Some(Value::Records(Records::new(count, record(&s.members, bytes, size, base)?)?))
}

fn record(members: &[Shape], bytes: &[u8], size: usize, base: u32) -> Option<Vec<(String, Value)>> {
    let count = bytes.len() / size;
    let column = |m: &Shape| -> Option<Value> {
        if m.field.kind == FieldType::Struct {
            return Some(Value::Records(Records::new(count, record(&m.members, bytes, size, base)?)?));
        }
        let kind = num(m.field.kind)?;
        let from = m.field.offset.checked_sub(base)? as usize;
        let at = from..from + kind.width();
        if at.end > size {
            return None;
        }
        let mut out = Vec::with_capacity(count * kind.width());
        for element in bytes.chunks_exact(size) {
            out.extend_from_slice(&element[at.clone()]);
        }
        Numbers::new(kind, out).map(Value::Numbers)
    };
    members.iter().map(|m| Some((m.field.name.clone(), column(m)?))).collect()
}

/// The kinds a list keeps packed. A 64 bit whole number stays one by one, as JS reads it as a BigInt.
fn num(t: FieldType) -> Option<Num> {
    use FieldType::*;
    Some(match t {
        U8 => Num::U8,
        I8 => Num::I8,
        U16 => Num::U16,
        I16 => Num::I16,
        U32 => Num::U32,
        I32 => Num::I32,
        F32 => Num::F32,
        F64 => Num::F64,
        _ => return None,
    })
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

/// An element of a list that is not kept packed.
fn element(t: FieldType, b: &[u8]) -> Value {
    let eight = || -> [u8; 8] { b.try_into().unwrap_or_default() };
    match t {
        FieldType::Bool => (b[0] != 0).into(),
        FieldType::U64 => u64::from_le_bytes(eight()).into(),
        FieldType::I64 => i64::from_le_bytes(eight()).into(),
        _ => Value::Null,
    }
}

/// A message from a value. Fields the value leaves out keep the schema's defaults.
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
    if value.as_map().is_none() {
        return Err(wants(prefix, "an object"));
    }
    for s in shapes {
        if let Some(v) = value.get(&s.field.name) {
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
            let n = v.whole().and_then(|n| u64::try_from(n).ok()).ok_or_else(|| wants(path, "a whole number of 0 or more"))?;
            m.set_uint(path, n).map_err(refused)?;
        }
        I8 | I16 | I32 | I64 => {
            let n = v.whole().and_then(|n| i64::try_from(n).ok()).ok_or_else(|| wants(path, "a whole number"))?;
            m.set_int(path, n).map_err(refused)?;
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
            Value::Text(option) => {
                m.set_enum(path, option).map_err(refused)?;
            }
            other => {
                let n = other.whole().and_then(|n| i64::try_from(n).ok()).ok_or_else(|| wants(path, "one of its options"))?;
                m.set_int(path, n).map_err(refused)?;
            }
        },
        Struct => members(m, &s.members, path, v)?,
        Array | VArray => write_list(m, s, path, v)?,
        _ => return Err(format!("{} cannot be written yet", label(path))),
    }
    Ok(())
}

fn write_list(m: &mut MessageBuilder, s: &Shape, path: &str, v: &Value) -> Result<(), String> {
    let refused = |e: rant::Error| e.to_string();
    let variable = s.field.kind == FieldType::VArray;
    // bytes go as they are, and numbers of the list's own kind, the rest one by one
    match (s.field.elem, v) {
        (FieldType::U8, Value::Bytes(bytes)) => {
            m.set_array(path, bytes).map_err(refused)?;
            return Ok(());
        }
        (elem, Value::Numbers(n)) if num(elem) == Some(n.kind()) => {
            m.set_array(path, n.bytes()).map_err(refused)?;
            return Ok(());
        }
        _ => {}
    }
    let items = v.items().ok_or_else(|| wants(path, "a list"))?;
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
            for item in items.iter() {
                push(&mut bytes, elem, item).ok_or_else(|| wants(path, "a list of numbers"))?;
            }
            m.set_array(path, &bytes).map_err(refused)?;
        }
    }
    Ok(())
}

fn push(out: &mut Vec<u8>, t: FieldType, v: &Value) -> Option<()> {
    use FieldType::*;
    let whole = || v.whole();
    match t {
        U8 => out.push(u8::try_from(whole()?).ok()?),
        I8 => out.push(i8::try_from(whole()?).ok()? as u8),
        Bool => out.push(v.as_bool()? as u8),
        U16 => out.extend(u16::try_from(whole()?).ok()?.to_le_bytes()),
        I16 => out.extend(i16::try_from(whole()?).ok()?.to_le_bytes()),
        U32 => out.extend(u32::try_from(whole()?).ok()?.to_le_bytes()),
        I32 => out.extend(i32::try_from(whole()?).ok()?.to_le_bytes()),
        U64 => out.extend(u64::try_from(whole()?).ok()?.to_le_bytes()),
        I64 => out.extend(i64::try_from(whole()?).ok()?.to_le_bytes()),
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
        let field = at.get_mut(part).ok_or_else(|| format!("{path} names no field"))?;
        if parts.peek().is_none() {
            *field = value;
            return Ok(());
        }
        at = field;
    }
    Err(format!("{path} names no field"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::value;
    use rant::{Node, NodeOptions};

    fn node() -> Node {
        Node::new("hmi_codec_test", NodeOptions::new().domain(152).multicast_interface("127.0.0.1")).unwrap()
    }

    /// A value as a screen reads it, whichever way it is kept.
    fn plain(v: &Value) -> serde_json::Value {
        serde_json::to_value(v).unwrap()
    }

    fn round_trip(dsl: &str, value: Value) {
        let node = node();
        let schema = node.schema(dsl).unwrap();
        let shapes = shapes(&schema);
        let bytes = encode(&schema, &shapes, &value).unwrap();
        assert_eq!(plain(&decode(&schema.view(&bytes), &shapes)), plain(&value), "{dsl}");
    }

    #[test]
    fn scalars_and_text() {
        round_trip(
            "Conveyor { speed: f64, running: bool, part: string<16>, count: u32, delta: i16, ratio: f32 }",
            value!({ "speed": 0.5, "running": true, "part": "A7", "count": 12, "delta": -3, "ratio": 0.25 }),
        );
    }

    #[test]
    fn a_bare_number() {
        round_trip("f64", value!(1.5));
    }

    #[test]
    fn nested_standard_types() {
        round_trip(
            "Arm { pose: Pose }",
            value!({ "pose": { "position": { "x": 1.0, "y": 2.0, "z": 3.0 },
                              "orientation": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 } } }),
        );
    }

    #[test]
    fn lists() {
        round_trip(
            "Lists { joints: f64[], fixed: f32[3], names: string<8>[], boxes: AlignedBox2D[] }",
            value!({ "joints": [0.5, -1.0], "fixed": [1.0, 2.0, 3.0], "names": ["a", "bc"],
                    "boxes": [ { "min": { "x": 0.0, "y": 1.0 }, "max": { "x": 2.0, "y": 3.0 } },
                               { "min": { "x": 4.0, "y": 5.0 }, "max": { "x": 6.0, "y": 7.0 } } ] }),
        );
    }

    #[test]
    fn lists_of_numbers_and_of_number_records_read_packed() {
        let node = node();
        let schema = node
            .schema(
                "LidarPoint { x: f32, y: f32, z: f32, intensity: u16 }
Cloud { stamp: f64, points: LidarPoint[], corners: Double2[2], poses: Pose[], ranges: f32[], big: u64[], marks: { at: f32, on: bool }[] }
",
            )
            .unwrap();
        let shapes = shapes(&schema);
        let pose = |x: f64| value!({ "position": { "x": x, "y": 0.5, "z": 0.0 }, "orientation": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 } });
        let written = value!({
            "stamp": 7.0,
            "points": [ { "x": 1.0, "y": 2.0, "z": 3.0, "intensity": 9 }, { "x": -1.0, "y": 0.5, "z": 0.25, "intensity": 300 } ],
            "corners": [ { "x": 1.0, "y": 2.0 }, { "x": 3.0, "y": 4.0 } ],
            "poses": [ pose(1.0), pose(2.0) ],
            "ranges": [ 0.5, 2.0, 4.0 ],
            "big": [ 1, 2 ],
            "marks": [ { "at": 1.0, "on": true } ]
        });
        let read = decode(&schema.view(&encode(&schema, &shapes, &written).unwrap()), &shapes);
        assert_eq!(plain(&read), plain(&written));
        let kind = |name: &str| match read.get(name) {
            Some(Value::Numbers(n)) => format!("{:?}", n.kind()),
            Some(Value::Records(_)) => "records".into(),
            Some(Value::List(_)) => "list".into(),
            other => format!("{other:?}"),
        };
        assert_eq!(["points", "corners", "poses", "ranges", "big", "marks"].map(kind), ["records", "records", "records", "F32", "list", "list"]);
        // packed values write back as they read
        assert_eq!(decode(&schema.view(&encode(&schema, &shapes, &read).unwrap()), &shapes), read);
    }

    #[test]
    fn a_list_of_bytes_reads_as_bytes() {
        round_trip("Picture { width: u32, data: u8[] }", Value::map([("width", 2u32.into()), ("data", Value::Bytes(vec![0, 7, 255]))]));
        // a list of numbers a handler wrote goes out as the same bytes
        let node = node();
        let schema = node.schema("Picture { data: u8[] }").unwrap();
        let bytes = encode(&schema, &shapes(&schema), &value!({ "data": [0, 7, 255] })).unwrap();
        assert_eq!(decode(&schema.view(&bytes), &shapes(&schema)), Value::map([("data", Value::Bytes(vec![0, 7, 255]))]));
    }

    #[test]
    fn enums_by_name() {
        round_trip("Line { mode: enum<u8> { Auto, Manual } }", value!({ "mode": "Manual" }));
    }

    #[test]
    fn enums_are_listed_once_and_an_anonymous_one_by_its_field() {
        let node = node();
        let schema = node.schema("LineMode = enum<u8> { Auto, Manual }
Line { mode: LineMode, part: { side_now: enum<u8> { Left, Right }, line_mode: enum<u8> { Up, Down } }, last: LineMode }").unwrap();
        let mut out = Vec::new();
        enums(&shapes(&schema), false, &mut out);
        enums(&shapes(&schema), true, &mut out);
        let names = |o: &[&str]| o.iter().map(|&n| n.to_owned()).collect::<Vec<_>>();
        assert_eq!(out, [
            EnumInfo { name: "LineMode".into(), options: names(&["Auto", "Manual"]) },
            EnumInfo { name: "SideNow".into(), options: names(&["Left", "Right"]) },
        ]);
    }

    #[test]
    fn a_missing_field_keeps_its_default() {
        let node = node();
        let schema = node.schema("Conveyor { speed: f64, running: bool }").unwrap();
        let shapes = shapes(&schema);
        let bytes = encode(&schema, &shapes, &value!({ "running": true })).unwrap();
        assert_eq!(decode(&schema.view(&bytes), &shapes), value!({ "speed": 0.0, "running": true }));
    }

    #[test]
    fn a_wrong_kind_is_refused_by_name() {
        let node = node();
        let schema = node.schema("Conveyor { speed: f64 }").unwrap();
        let err = encode(&schema, &shapes(&schema), &value!({ "speed": "fast" })).unwrap_err();
        assert_eq!(err, "speed takes a number");
    }

    #[test]
    fn put_sets_one_field() {
        let mut v = value!({ "a": { "b": 1 }, "c": 2 });
        put(&mut v, "a.b", value!(5)).unwrap();
        assert_eq!(v, value!({ "a": { "b": 5 }, "c": 2 }));
        assert!(put(&mut v, "a.x", value!(1)).is_err());
    }
}
