//! Canonical arbitrary-precision integers with allocation-free machine values.
use num_bigint::{BigInt, ParseBigIntError, Sign};
use num_traits::{ToPrimitive, Zero};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::cmp::Ordering;
use std::fmt;
use std::ops::{Add, AddAssign, Div, Mul, Neg, Rem, Shl, Shr, Sub, SubAssign};
use std::rc::Rc;
use std::str::FromStr;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum Representation {
    Small(i64),
    Large(Rc<BigInt>),
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Integer(Representation);

impl Integer {
    fn from_big(value: BigInt) -> Self {
        match value.to_i64() {
            Some(value) => Self(Representation::Small(value)),
            None => Self(Representation::Large(Rc::new(value))),
        }
    }

    fn big(&self) -> std::borrow::Cow<'_, BigInt> {
        match &self.0 {
            Representation::Small(value) => std::borrow::Cow::Owned(BigInt::from(*value)),
            Representation::Large(value) => std::borrow::Cow::Borrowed(value),
        }
    }

    pub(crate) fn parse_bytes(bytes: &[u8], radix: u32) -> Option<Self> {
        BigInt::parse_bytes(bytes, radix).map(Self::from_big)
    }

    pub(crate) fn bits(&self) -> u64 {
        match &self.0 {
            Representation::Small(value) => u64::from(64 - value.unsigned_abs().leading_zeros()),
            Representation::Large(value) => value.bits(),
        }
    }

    pub(crate) fn sign(&self) -> Sign {
        match &self.0 {
            Representation::Small(value) => match value.cmp(&0) {
                Ordering::Less => Sign::Minus,
                Ordering::Equal => Sign::NoSign,
                Ordering::Greater => Sign::Plus,
            },
            Representation::Large(value) => value.sign(),
        }
    }

    pub(crate) fn to_signed_bytes_le(&self) -> Vec<u8> {
        self.big().to_signed_bytes_le()
    }

    pub(crate) fn to_signed_bytes_be(&self) -> Vec<u8> {
        self.big().to_signed_bytes_be()
    }

    pub(crate) fn to_bytes_le(&self) -> (Sign, Vec<u8>) {
        self.big().to_bytes_le()
    }
}

impl Default for Integer {
    fn default() -> Self {
        Self(Representation::Small(0))
    }
}

impl fmt::Display for Integer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            Representation::Small(value) => value.fmt(formatter),
            Representation::Large(value) => value.fmt(formatter),
        }
    }
}

impl FromStr for Integer {
    type Err = ParseBigIntError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if let Ok(value) = text.parse::<i64>() {
            return Ok(Self(Representation::Small(value)));
        }
        text.parse::<BigInt>().map(Self::from_big)
    }
}

impl Serialize for Integer {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Capsules retain num-bigint's wire representation, independent of storage.
        self.big().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Integer {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        BigInt::deserialize(deserializer).map(Self::from_big)
    }
}

impl Ord for Integer {
    fn cmp(&self, other: &Self) -> Ordering {
        match (&self.0, &other.0) {
            (Representation::Small(left), Representation::Small(right)) => left.cmp(right),
            _ => self.big().cmp(&other.big()),
        }
    }
}

impl PartialOrd for Integer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl ToPrimitive for Integer {
    fn to_i64(&self) -> Option<i64> {
        match &self.0 {
            Representation::Small(value) => Some(*value),
            Representation::Large(_) => None,
        }
    }

    fn to_u64(&self) -> Option<u64> {
        match &self.0 {
            Representation::Small(value) => u64::try_from(*value).ok(),
            Representation::Large(value) => value.to_u64(),
        }
    }

    fn to_f64(&self) -> Option<f64> {
        match &self.0 {
            Representation::Small(value) => Some(*value as f64),
            Representation::Large(value) => value.to_f64(),
        }
    }

    fn to_f32(&self) -> Option<f32> {
        match &self.0 {
            Representation::Small(value) => Some(*value as f32),
            Representation::Large(value) => value.to_f32(),
        }
    }
}

macro_rules! integer_from {
    ($($source:ty),*) => {$ (
        impl From<$source> for Integer {
            fn from(value: $source) -> Self {
                match i64::try_from(value) {
                    Ok(value) => Self(Representation::Small(value)),
                    Err(_) => Self::from_big(BigInt::from(value)),
                }
            }
        }
    )*};
}
integer_from!(
    i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize
);

impl From<bool> for Integer {
    fn from(value: bool) -> Self {
        Self::from(i64::from(value))
    }
}

#[derive(Debug)]
pub struct IntegerOutOfRange;

impl fmt::Display for IntegerOutOfRange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("out of range conversion regarding big integer attempted")
    }
}

macro_rules! integer_try_into {
    ($target:ty, $convert:ident) => {
        impl TryFrom<&Integer> for $target {
            type Error = IntegerOutOfRange;
            fn try_from(value: &Integer) -> Result<Self, Self::Error> {
                value.$convert().ok_or(IntegerOutOfRange)
            }
        }
        impl TryFrom<Integer> for $target {
            type Error = IntegerOutOfRange;
            fn try_from(value: Integer) -> Result<Self, Self::Error> {
                Self::try_from(&value)
            }
        }
    };
}
integer_try_into!(u8, to_u8);
integer_try_into!(u32, to_u32);
integer_try_into!(usize, to_usize);

macro_rules! binary_operation {
    ($trait:ident, $method:ident, $checked:ident) => {
        impl $trait<&Integer> for &Integer {
            type Output = Integer;
            fn $method(self, right: &Integer) -> Integer {
                if let (Representation::Small(left), Representation::Small(right)) =
                    (&self.0, &right.0)
                    && let Some(value) = left.$checked(*right)
                {
                    return Integer(Representation::Small(value));
                }
                Integer::from_big(self.big().as_ref().$method(right.big().as_ref()))
            }
        }
        impl $trait<Integer> for Integer {
            type Output = Integer;
            fn $method(self, right: Integer) -> Integer {
                (&self).$method(&right)
            }
        }
        impl $trait<&Integer> for Integer {
            type Output = Integer;
            fn $method(self, right: &Integer) -> Integer {
                (&self).$method(right)
            }
        }
        impl $trait<Integer> for &Integer {
            type Output = Integer;
            fn $method(self, right: Integer) -> Integer {
                self.$method(&right)
            }
        }
        impl $trait<i32> for Integer {
            type Output = Integer;
            fn $method(self, right: i32) -> Integer {
                self.$method(Integer::from(right))
            }
        }
        impl $trait<i32> for &Integer {
            type Output = Integer;
            fn $method(self, right: i32) -> Integer {
                self.$method(Integer::from(right))
            }
        }
    };
}
binary_operation!(Add, add, checked_add);
binary_operation!(Sub, sub, checked_sub);
binary_operation!(Mul, mul, checked_mul);
binary_operation!(Div, div, checked_div);
binary_operation!(Rem, rem, checked_rem);

impl AddAssign<&Integer> for Integer {
    fn add_assign(&mut self, right: &Integer) {
        *self = &*self + right;
    }
}
impl AddAssign<Integer> for Integer {
    fn add_assign(&mut self, right: Integer) {
        *self += &right;
    }
}
impl SubAssign<&Integer> for Integer {
    fn sub_assign(&mut self, right: &Integer) {
        *self = &*self - right;
    }
}
impl SubAssign<Integer> for Integer {
    fn sub_assign(&mut self, right: Integer) {
        *self -= &right;
    }
}

impl Neg for &Integer {
    type Output = Integer;
    fn neg(self) -> Integer {
        if let Representation::Small(value) = &self.0
            && let Some(value) = value.checked_neg()
        {
            return Integer(Representation::Small(value));
        }
        Integer::from_big(-self.big().as_ref())
    }
}
impl Neg for Integer {
    type Output = Integer;
    fn neg(self) -> Integer {
        -&self
    }
}

impl Shl<usize> for &Integer {
    type Output = Integer;
    fn shl(self, shift: usize) -> Integer {
        if let Representation::Small(value) = &self.0 {
            if *value == 0 {
                return Integer::default();
            }
            if shift < 64 {
                return Integer::from(i128::from(*value) << shift);
            }
        }
        Integer::from_big(self.big().as_ref() << shift)
    }
}
impl Shl<usize> for Integer {
    type Output = Integer;
    fn shl(self, shift: usize) -> Integer {
        (&self) << shift
    }
}

impl Shr<usize> for &Integer {
    type Output = Integer;
    fn shr(self, shift: usize) -> Integer {
        if let Representation::Small(value) = &self.0 {
            return Integer::from(*value >> shift.min(63));
        }
        Integer::from_big(self.big().as_ref() >> shift)
    }
}

impl Zero for Integer {
    fn zero() -> Self {
        Self::default()
    }
    fn is_zero(&self) -> bool {
        matches!(self.0, Representation::Small(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    #[test]
    fn arithmetic_matches_arbitrary_precision_across_machine_boundaries() {
        let values = [
            "0",
            "1",
            "-1",
            "9223372036854775807",
            "-9223372036854775808",
            "9223372036854775808",
            "-9223372036854775809",
            "1361129467683753853853498429727072845824",
        ];
        for left in values {
            let small = left.parse::<Integer>().unwrap();
            let big = left.parse::<BigInt>().unwrap();
            assert_eq!((-&small).to_string(), (-&big).to_string());
            for right in values {
                let small_right = right.parse::<Integer>().unwrap();
                let big_right = right.parse::<BigInt>().unwrap();
                assert_eq!(
                    (&small + &small_right).to_string(),
                    (&big + &big_right).to_string()
                );
                assert_eq!(
                    (&small - &small_right).to_string(),
                    (&big - &big_right).to_string()
                );
                assert_eq!(
                    (&small * &small_right).to_string(),
                    (&big * &big_right).to_string()
                );
                assert_eq!(small.cmp(&small_right), big.cmp(&big_right));
                if !big_right.is_zero() {
                    assert_eq!(
                        (&small / &small_right).to_string(),
                        (&big / &big_right).to_string()
                    );
                    assert_eq!(
                        (&small % &small_right).to_string(),
                        (&big % &big_right).to_string()
                    );
                }
            }
            for shift in [0, 1, 63, 64, 127, 256] {
                assert_eq!((&small << shift).to_string(), (&big << shift).to_string());
                assert_eq!((&small >> shift).to_string(), (&big >> shift).to_string());
            }
            assert_eq!(small.to_f32(), big.to_f32());
            assert_eq!(small.to_f64(), big.to_f64());
            assert_eq!(small.bits(), big.bits());
            assert_eq!(small.to_signed_bytes_le(), big.to_signed_bytes_le());
            assert_eq!(
                rmp_serde::to_vec(&small).unwrap(),
                rmp_serde::to_vec(&big).unwrap()
            );
        }
    }

    #[test]
    fn promoted_results_normalize_back_to_inline_values() {
        let overflow = Integer::from(i64::MAX) + 1;
        assert!(matches!(overflow.0, Representation::Large(_)));
        let recovered = overflow - 1;
        assert!(matches!(recovered.0, Representation::Small(i64::MAX)));
        let direct = Integer::from(i64::MAX);
        let mut left = DefaultHasher::new();
        let mut right = DefaultHasher::new();
        recovered.hash(&mut left);
        direct.hash(&mut right);
        assert_eq!(left.finish(), right.finish());
        let decoded: Integer = rmp_serde::from_slice(&rmp_serde::to_vec(&direct).unwrap()).unwrap();
        assert_eq!(decoded, direct);
    }
}
