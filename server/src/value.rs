//! A value as the HMI holds it, in CBOR's data model: bytes stay bytes and whole numbers stay
//! whole. It goes to screens as CBOR and into the project's files as TOML, never as JSON.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use ciborium::tag::Captured;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, Serializer};
use ts_rs::TS;

/// The CBOR tag of [`Records`], a map of their columns. Unassigned, in the range anyone may take.
const RECORDS_TAG: u64 = 41000;
/// The CBOR tag of [`Numbers`] shuffled then LZ4 compressed: their typed array's tag, then the
/// block with its size first. Unassigned, beside [`RECORDS_TAG`].
const COMPRESSED_TAG: u64 = 41001;
/// Numbers of fewer bytes go as they are, as compressing them never pays.
const COMPRESS_FROM: usize = 4096;

#[derive(Clone, Debug, PartialEq, Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    /// A whole number, from i64's least to u64's most, as far as Rant's integers reach.
    Int(i128),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
    List(Vec<Value>),
    /// A list of numbers of one kind, packed as Rant packs them.
    Numbers(Numbers),
    /// A list of records whose fields are all numbers, a column a field.
    Records(Records),
    /// Fields in the order they were written, as a schema orders them.
    Map(Vec<(String, Value)>),
}

impl Value {
    /// A map from its fields, in this order.
    pub fn map<K: Into<String>>(fields: impl IntoIterator<Item = (K, Value)>) -> Value {
        Value::Map(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// A number of either kind as a float.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Int(n) => Some(*n as f64),
            Value::Float(f) => Some(*f),
            _ => None,
        }
    }

    /// A whole number, from an integer or a float with nothing after the point.
    pub fn whole(&self) -> Option<i128> {
        match self {
            Value::Int(n) => Some(*n),
            Value::Float(f) if f.fract() == 0.0 && f.abs() < 2f64.powi(64) => Some(*f as i128),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Text(t) => Some(t),
            _ => None,
        }
    }

    /// A list's items, whichever way it is kept. A packed one's are made here, so a big one costs.
    pub fn items(&self) -> Option<Cow<'_, [Value]>> {
        match self {
            Value::List(items) => Some(Cow::Borrowed(items)),
            Value::Numbers(n) => Some(Cow::Owned(n.iter().collect())),
            Value::Records(r) => Some(Cow::Owned((0..r.len).map(|i| r.get(i)).collect())),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&[(String, Value)]> {
        match self {
            Value::Map(fields) => Some(fields),
            _ => None,
        }
    }

    /// A map's field.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_map()?.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        match self {
            Value::Map(fields) => fields.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Value {
        Value::Bool(b)
    }
}

impl From<f64> for Value {
    fn from(f: f64) -> Value {
        Value::Float(f)
    }
}

impl From<&str> for Value {
    fn from(t: &str) -> Value {
        Value::Text(t.to_owned())
    }
}

impl From<String> for Value {
    fn from(t: String) -> Value {
        Value::Text(t)
    }
}

/// What each number of [`Numbers`] is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Num {
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    F32,
    F64,
}

impl Num {
    /// Its bytes.
    pub fn width(self) -> usize {
        match self {
            Num::U8 | Num::I8 => 1,
            Num::U16 | Num::I16 => 2,
            Num::U32 | Num::I32 | Num::F32 => 4,
            Num::F64 => 8,
        }
    }

    /// RFC 8746's tag for a typed array of them, little endian.
    fn tag(self) -> u64 {
        match self {
            Num::U8 => 64,
            Num::I8 => 72,
            Num::U16 => 69,
            Num::I16 => 77,
            Num::U32 => 70,
            Num::I32 => 78,
            Num::F32 => 85,
            Num::F64 => 86,
        }
    }

    /// The number that `b`, exactly its width, holds little endian.
    fn read(self, b: &[u8]) -> Value {
        let mut a = [0; 8];
        a[..b.len()].copy_from_slice(b);
        let (two, four) = ([a[0], a[1]], [a[0], a[1], a[2], a[3]]);
        match self {
            Num::U8 => a[0].into(),
            Num::I8 => (a[0] as i8).into(),
            Num::U16 => u16::from_le_bytes(two).into(),
            Num::I16 => i16::from_le_bytes(two).into(),
            Num::U32 => u32::from_le_bytes(four).into(),
            Num::I32 => i32::from_le_bytes(four).into(),
            Num::F32 => Value::Float(f32::from_le_bytes(four).into()),
            Num::F64 => Value::Float(f64::from_le_bytes(a)),
        }
    }
}

/// A list of numbers of one kind as their little endian bytes, so a copy shares them.
#[derive(Clone, Debug, PartialEq)]
pub struct Numbers {
    kind: Num,
    bytes: Arc<[u8]>,
}

impl Numbers {
    /// None when `bytes` is not a whole number of them.
    pub fn new(kind: Num, bytes: impl Into<Arc<[u8]>>) -> Option<Numbers> {
        let bytes = bytes.into();
        (bytes.len() % kind.width() == 0).then_some(Numbers { kind, bytes })
    }

    pub fn kind(&self) -> Num {
        self.kind
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    fn len(&self) -> usize {
        self.bytes.len() / self.kind.width()
    }

    fn iter(&self) -> impl Iterator<Item = Value> + '_ {
        self.bytes.chunks_exact(self.kind.width()).map(|b| self.kind.read(b))
    }

    /// Written for a screen: a typed array, compressed when that makes it smaller.
    fn typed<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if self.bytes.len() >= COMPRESS_FROM {
            let block = lz4_flex::compress_prepend_size(&shuffled(&self.bytes, self.kind.width()));
            if block.len() < self.bytes.len() {
                return Captured(Some(COMPRESSED_TAG), (self.kind.tag(), Raw(&block))).serialize(s);
            }
        }
        Captured(Some(self.kind.tag()), Raw(&self.bytes)).serialize(s)
    }
}

/// Every number's first byte, then every second byte and so on, so the bytes that barely change
/// from one number to the next stand together, where LZ4 finds them.
fn shuffled(bytes: &[u8], width: usize) -> Cow<'_, [u8]> {
    if width == 1 {
        return Cow::Borrowed(bytes);
    }
    let n = bytes.len() / width;
    let mut out = vec![0; bytes.len()];
    for (i, number) in bytes.chunks_exact(width).enumerate() {
        for (b, &byte) in number.iter().enumerate() {
            out[b * n + i] = byte;
        }
    }
    Cow::Owned(out)
}

/// A list of records whose fields are all numbers, as a column a field: numbers, or records
/// again for a struct, each as long as the list.
#[derive(Clone, Debug, PartialEq)]
pub struct Records {
    len: usize,
    fields: Arc<[(String, Value)]>,
}

impl Records {
    /// None unless there are columns, each numbers or records `len` long, as the length is theirs.
    pub fn new(len: usize, fields: Vec<(String, Value)>) -> Option<Records> {
        let fits = |v: &Value| match v {
            Value::Numbers(n) => n.len() == len,
            Value::Records(r) => r.len == len,
            _ => false,
        };
        (!fields.is_empty() && fields.iter().all(|(_, v)| fits(v))).then(|| Records { len, fields: fields.into() })
    }

    /// Record `i`, which must be there.
    fn get(&self, i: usize) -> Value {
        Value::Map(self.fields.iter().map(|(k, column)| (k.clone(), cell(column, i))).collect())
    }
}

/// Item `i` of a column, which [`Records::new`] made sure is there.
fn cell(column: &Value, i: usize) -> Value {
    match column {
        Value::Numbers(n) => {
            let w = n.kind.width();
            n.bytes.get(i * w..(i + 1) * w).map_or(Value::Null, |b| n.kind.read(b))
        }
        Value::Records(r) => r.get(i),
        _ => Value::Null,
    }
}

/// Record `.1` of columns, written as a map without making one.
struct Row<'a>(&'a [(String, Value)], usize);

impl Serialize for Row<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, column) in self.0 {
            match column {
                Value::Records(r) => map.serialize_entry(k, &Row(&r.fields, self.1))?,
                other => map.serialize_entry(k, &cell(other, self.1))?,
            }
        }
        map.end()
    }
}

/// Bytes written as one byte string.
struct Raw<'a>(&'a [u8]);

impl Serialize for Raw<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(self.0)
    }
}

/// Fields written as a map, in their order.
struct Fields<'a>(&'a [(String, Value)]);

impl Serialize for Fields<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_map(self.0.iter().map(|(k, v)| (k, v)))
    }
}

macro_rules! from_int {
    ($($t:ty),*) => {$(
        impl From<$t> for Value {
            fn from(n: $t) -> Value {
                Value::Int(n.into())
            }
        }
    )*};
}
from_int!(u8, u16, u32, u64, i8, i16, i32, i64);

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Null => s.serialize_unit(),
            Value::Bool(b) => s.serialize_bool(*b),
            // what fits an i64 goes as one, so TOML, which has no wider integer, takes it
            Value::Int(n) => match i64::try_from(*n) {
                Ok(n) => s.serialize_i64(n),
                Err(_) => s.serialize_u64(u64::try_from(*n).map_err(serde::ser::Error::custom)?),
            },
            Value::Float(f) => s.serialize_f64(*f),
            Value::Text(t) => s.serialize_str(t),
            Value::Bytes(b) => s.serialize_bytes(b),
            Value::List(items) => s.collect_seq(items),
            // screens read a typed array whole, files take a plain list
            Value::Numbers(n) if !s.is_human_readable() => n.typed(s),
            Value::Records(r) if !s.is_human_readable() => Captured(Some(RECORDS_TAG), Fields(&r.fields)).serialize(s),
            Value::Numbers(n) => s.collect_seq(n.iter()),
            Value::Records(r) => s.collect_seq((0..r.len).map(|i| Row(&r.fields, i))),
            Value::Map(fields) => Fields(fields).serialize(s),
        }
    }
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Value, D::Error> {
        d.deserialize_any(ValueVisitor)
    }
}

struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a value")
    }

    fn visit_bool<E>(self, b: bool) -> Result<Value, E> {
        Ok(Value::Bool(b))
    }

    fn visit_i64<E>(self, n: i64) -> Result<Value, E> {
        Ok(Value::Int(n.into()))
    }

    fn visit_u64<E>(self, n: u64) -> Result<Value, E> {
        Ok(Value::Int(n.into()))
    }

    fn visit_i128<E>(self, n: i128) -> Result<Value, E> {
        Ok(Value::Int(n))
    }

    fn visit_u128<E: de::Error>(self, n: u128) -> Result<Value, E> {
        i128::try_from(n).map(Value::Int).map_err(E::custom)
    }

    fn visit_f64<E>(self, f: f64) -> Result<Value, E> {
        Ok(Value::Float(f))
    }

    fn visit_str<E>(self, t: &str) -> Result<Value, E> {
        Ok(Value::Text(t.to_owned()))
    }

    fn visit_string<E>(self, t: String) -> Result<Value, E> {
        Ok(Value::Text(t))
    }

    fn visit_bytes<E>(self, b: &[u8]) -> Result<Value, E> {
        Ok(Value::Bytes(b.to_vec()))
    }

    fn visit_byte_buf<E>(self, b: Vec<u8>) -> Result<Value, E> {
        Ok(Value::Bytes(b))
    }

    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        Value::deserialize(d)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(v) = seq.next_element()? {
            items.push(v);
        }
        Ok(Value::List(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut fields = Vec::with_capacity(map.size_hint().unwrap_or(0));
        while let Some((k, v)) = map.next_entry::<String, Value>()? {
            fields.push((k, v));
        }
        Ok(Value::Map(fields))
    }
}

/// For logs: a value written briefly, as code would write it.
impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Value::Null => f.write_str("null"),
            Value::Bool(b) => write!(f, "{b}"),
            Value::Int(n) => write!(f, "{n}"),
            Value::Float(x) => write!(f, "{x}"),
            Value::Text(t) => write!(f, "{t:?}"),
            Value::Bytes(b) => write!(f, "{} bytes", b.len()),
            Value::Numbers(n) => write!(f, "{} numbers", n.len()),
            Value::Records(r) => write!(f, "{} records", r.len),
            Value::List(items) => {
                f.write_str("[")?;
                for (i, v) in items.iter().enumerate() {
                    write!(f, "{}{v}", if i > 0 { ", " } else { "" })?;
                }
                f.write_str("]")
            }
            Value::Map(fields) => {
                f.write_str("{")?;
                for (i, (k, v)) in fields.iter().enumerate() {
                    write!(f, "{}{k}: {v}", if i > 0 { ", " } else { " " })?;
                }
                f.write_str(if fields.is_empty() { "}" } else { " }" })
            }
        }
    }
}

// What screens see a value as, declared for TypeScript only: bytes arrive as a Uint8Array and
// a whole number past JS's safe ones as a bigint. Not a doc comment, since ts-rs writes the
// file both from here and from every type using it, and those must agree.
#[derive(TS)]
#[ts(rename = "Value", untagged, export)]
#[allow(dead_code)]
enum ValueShape {
    Null(()),
    Boolean(bool),
    Number(f64),
    #[ts(type = "bigint")]
    Big(i64),
    Text(String),
    #[ts(type = "Uint8Array")]
    Bytes(Vec<u8>),
    List(Vec<ValueShape>),
    Map(HashMap<String, ValueShape>),
}

impl TS for Value {
    type WithoutGenerics = Value;

    fn ident() -> String {
        ValueShape::ident()
    }

    fn name() -> String {
        ValueShape::name()
    }

    fn inline() -> String {
        ValueShape::inline()
    }

    fn inline_flattened() -> String {
        ValueShape::inline_flattened()
    }

    fn visit_dependencies(v: &mut impl ts_rs::TypeVisitor)
    where
        Self: 'static,
    {
        ValueShape::visit_dependencies(v);
    }

    fn decl() -> String {
        ValueShape::decl()
    }

    fn decl_concrete() -> String {
        ValueShape::decl_concrete()
    }

    fn output_path() -> Option<&'static std::path::Path> {
        ValueShape::output_path()
    }
}

/// Tests write values as JSON literals, which this makes ours: `value!({ "speed": 0.5 })`.
#[cfg(test)]
macro_rules! value {
    ($($literal:tt)+) => {
        $crate::value::Value::from(serde_json::json!($($literal)+))
    };
}
#[cfg(test)]
pub(crate) use value;

#[cfg(test)]
impl From<serde_json::Value> for Value {
    fn from(v: serde_json::Value) -> Value {
        match v {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(b) => Value::Bool(b),
            serde_json::Value::Number(n) => match (n.as_i64(), n.as_u64()) {
                (Some(i), _) => Value::Int(i.into()),
                (_, Some(u)) => Value::Int(u.into()),
                _ => Value::Float(n.as_f64().unwrap_or(f64::NAN)),
            },
            serde_json::Value::String(t) => Value::Text(t),
            serde_json::Value::Array(items) => Value::List(items.into_iter().map(Value::from).collect()),
            serde_json::Value::Object(fields) => Value::Map(fields.into_iter().map(|(k, v)| (k, Value::from(v))).collect()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cbor(v: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        ciborium::into_writer(v, &mut out).unwrap();
        out
    }

    #[test]
    fn a_value_goes_through_cbor_whole() {
        let v = Value::map([
            ("image", Value::Bytes(vec![0, 255, 7])),
            ("count", Value::Int(u64::MAX.into())),
            ("delta", Value::Int(-3)),
            ("ratio", Value::Float(0.25)),
            ("names", Value::List(vec!["a".into(), Value::Null, true.into()])),
        ]);
        assert_eq!(ciborium::from_reader::<Value, _>(&cbor(&v)[..]).unwrap(), v);
        // bytes are one CBOR byte string, not a list of numbers
        assert!(cbor(&Value::Bytes(vec![1; 300])).len() < 310);
    }

    #[test]
    fn packed_lists_go_to_screens_as_typed_arrays_and_to_files_as_lists() {
        let floats: Vec<u8> = [1.5f32, -2.0].iter().flat_map(|f| f.to_le_bytes()).collect();
        let x = Value::Numbers(Numbers::new(Num::F32, floats.clone()).unwrap());
        let i = Value::Numbers(Numbers::new(Num::U16, vec![7, 0, 9, 0]).unwrap());
        let points = Value::Records(Records::new(2, vec![("x".into(), x.clone()), ("i".into(), i)]).unwrap());
        use ciborium::Value as C;
        let read = |v: &Value| ciborium::from_reader::<C, _>(&cbor(v)[..]).unwrap();
        let tagged = |tag, bytes| C::Tag(tag, Box::new(C::Bytes(bytes)));
        assert_eq!(read(&x), tagged(85, floats.clone()));
        let columns = vec![(C::Text("x".into()), tagged(85, floats)), (C::Text("i".into()), tagged(69, vec![7, 0, 9, 0]))];
        assert_eq!(read(&points), C::Tag(41000, Box::new(C::Map(columns))));
        assert_eq!(serde_json::to_value(&points).unwrap(), serde_json::json!([{ "x": 1.5, "i": 7 }, { "x": -2.0, "i": 9 }]));
    }

    #[test]
    fn big_numbers_go_to_screens_compressed_when_that_makes_them_smaller() {
        use ciborium::Value as C;
        let read = |v: &Value| ciborium::from_reader::<C, _>(&cbor(v)[..]).unwrap();
        assert_eq!(shuffled(&[1, 2, 3, 4, 5, 6, 7, 8], 4).as_ref(), [1, 5, 2, 6, 3, 7, 4, 8]);
        let floats: Vec<u8> = (0..2000).flat_map(|i| (i as f32 * 0.01).to_le_bytes()).collect();
        let C::Tag(41001, content) = read(&Value::Numbers(Numbers::new(Num::F32, floats.clone()).unwrap())) else { panic!("not compressed") };
        let C::Array(parts) = *content else { panic!("not a kind and a block") };
        let [C::Integer(tag), C::Bytes(block)] = &parts[..] else { panic!("not a kind and a block") };
        assert_eq!(u64::try_from(*tag).unwrap(), 85);
        assert!(block.len() < floats.len() / 2);
        assert_eq!(lz4_flex::decompress_size_prepended(block).unwrap(), shuffled(&floats, 4).as_ref());
        // noise LZ4 cannot shrink goes as it is
        let mut seed = 0x2545f491u32;
        let noise: Vec<u8> = (0..5000)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            })
            .collect();
        assert_eq!(read(&Value::Numbers(Numbers::new(Num::U8, noise.clone()).unwrap())), C::Tag(64, Box::new(C::Bytes(noise))));
    }

    #[test]
    fn a_value_goes_through_toml() {
        let v = Value::map([("low", Value::Float(0.5)), ("high", Value::List(vec![1.into(), 2.into()])), ("mode", "Auto".into())]);
        #[derive(serde::Serialize, serde::Deserialize)]
        struct File {
            start: Value,
        }
        let text = toml::to_string(&File { start: v.clone() }).unwrap();
        assert_eq!(toml::from_str::<File>(&text).unwrap().start, v);
    }

    #[test]
    fn whole_numbers_read_from_either_kind() {
        assert_eq!(Value::Float(3.0).whole(), Some(3));
        assert_eq!(Value::Float(3.5).whole(), None);
        assert_eq!(Value::Int(-2).as_f64(), Some(-2.0));
    }
}
