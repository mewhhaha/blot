// Generated from source fixities in src/prelude/prelude.blot. Do not edit.

export const generatedFixities = [
  {
    "operator": "$",
    "associativity": "right",
    "precedence": 10,
    "target": "Fn.apply"
  },
  {
    "operator": "|>",
    "associativity": "left",
    "precedence": 20,
    "target": "Fn.pipe"
  },
  {
    "operator": "~",
    "associativity": "left",
    "precedence": 21,
    "target": "@type.performs"
  },
  {
    "operator": "||",
    "associativity": "right",
    "precedence": 22,
    "target": "Logic.or"
  },
  {
    "operator": "&&",
    "associativity": "right",
    "precedence": 24,
    "target": "Logic.and"
  },
  {
    "operator": "->",
    "associativity": "right",
    "precedence": 25,
    "target": "@type.arrow"
  },
  {
    "operator": "~>",
    "associativity": "right",
    "precedence": 25,
    "target": "@type.deferred_arrow"
  },
  {
    "operator": "==",
    "associativity": "none",
    "precedence": 30,
    "target": "Op.eq"
  },
  {
    "operator": "!=",
    "associativity": "none",
    "precedence": 30,
    "target": "Op.ne"
  },
  {
    "operator": "<",
    "associativity": "none",
    "precedence": 30,
    "target": "Op.lt"
  },
  {
    "operator": "<=",
    "associativity": "none",
    "precedence": 30,
    "target": "Op.le"
  },
  {
    "operator": ">",
    "associativity": "none",
    "precedence": 30,
    "target": "Op.gt"
  },
  {
    "operator": ">=",
    "associativity": "none",
    "precedence": 30,
    "target": "Op.ge"
  },
  {
    "operator": "|",
    "associativity": "left",
    "precedence": 40,
    "target": "Type.union"
  },
  {
    "operator": "\\",
    "associativity": "left",
    "precedence": 40,
    "target": "Type.diff"
  },
  {
    "operator": "&",
    "associativity": "left",
    "precedence": 45,
    "target": "Type.intersect"
  },
  {
    "operator": "<+",
    "associativity": "left",
    "precedence": 50,
    "target": "attach"
  },
  {
    "operator": "<>",
    "associativity": "right",
    "precedence": 55,
    "target": "Text.append"
  },
  {
    "operator": "+",
    "associativity": "left",
    "precedence": 60,
    "target": "Op.add"
  },
  {
    "operator": "-",
    "associativity": "left",
    "precedence": 60,
    "target": "Op.sub"
  },
  {
    "operator": "*",
    "associativity": "left",
    "precedence": 70,
    "target": "Op.mul"
  },
  {
    "operator": "/",
    "associativity": "left",
    "precedence": 70,
    "target": "Op.div"
  },
  {
    "operator": "%",
    "associativity": "left",
    "precedence": 70,
    "target": "Op.rem"
  },
  {
    "operator": "-",
    "associativity": "prefix",
    "precedence": 90,
    "target": "Int.negate"
  },
  {
    "operator": "!",
    "associativity": "prefix",
    "precedence": 90,
    "target": "@linear.own"
  },
  {
    "operator": "?",
    "associativity": "prefix",
    "precedence": 90,
    "target": "@linear.maybe"
  },
  {
    "operator": "&",
    "associativity": "prefix",
    "precedence": 90,
    "target": "@linear.borrow"
  }
] as const;
