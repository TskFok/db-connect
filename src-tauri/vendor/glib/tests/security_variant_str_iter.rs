use glib::{prelude::*, Variant};

// RUSTSEC-2024-0429: an FFI out parameter must not point at an immutable
// reference. Run in release mode: LLVM can otherwise leave the UB hidden.
#[test]
fn string_array_iteration_preserves_borrowed_values_under_optimization() {
    let values = ["", "数据库", "alpha", "🦀", "omega"];
    let variant = Variant::array_from_iter::<String>(values.iter().map(|value| value.to_variant()));

    assert_eq!(
        variant.array_iter_str().unwrap().collect::<Vec<_>>(),
        values
    );
    assert_eq!(
        variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
        values.into_iter().rev().collect::<Vec<_>>()
    );

    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some(""));
    assert_eq!(iter.next_back(), Some("omega"));
    assert_eq!(iter.nth(1), Some("alpha"));
    assert_eq!(iter.nth_back(0), Some("🦀"));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
    assert_eq!(variant.array_iter_str().unwrap().last(), Some("omega"));
}
