from pathlib import Path

p = Path("compiler/src/typecheck.rs")
s = p.read_text()
old = '''                    let is_resolve_op = static_member(&target_value, name)
                        .as_ref()
                        .is_some_and(|val| is_operator_member_closure(&self.context, val));
                    let parameter_type = if is_resolve_op {
'''
new = '''                    let is_resolve_op = static_member(&target_value, name)
                        .as_ref()
                        .is_some_and(|val| is_operator_member_closure(&self.context, val));
                    if is_resolve_op
                        && matches!(target_value, Value::Extended { .. })
                        && arguments.len() >= 2
                        && let Ok(value) =
                            self.evaluate(path, expression_id, values, Phase::Comptime)
                        && !matches!(value, Value::Closure { .. })
                    {
                        let operator_type = match name.as_str() {
                            "eq" | "ne" | "lt" | "le" | "gt" | "ge" => Some(bool_type()),
                            "add" | "sub" | "mul" | "div" | "rem" => self
                                .resolve_operand_domain(&arguments[0], &arguments[1])
                                .map(|domain| match domain {
                                    Domain::Int => int_type(),
                                    Domain::Text => text_type(),
                                    Domain::Float => float_type(),
                                    Domain::Float32 => float32_type(),
                                }),
                            _ => None,
                        };
                        if let Some(type_) = operator_type {
                            return Ok(Inferred { type_, effects });
                        }
                    }
                    if is_resolve_op && arguments.len() >= 2 {
                        let domain = self.resolve_operand_domain(&arguments[0], &arguments[1]);
                        if let Some(domain) = domain {
                            let span = module.arena.expression_span(expression_id);
                            match domain {
                                Domain::Int => {
                                    let int = int_type();
                                    self.constrain(arguments[0].clone(), int.clone(), span)?;
                                    self.constrain(arguments[1].clone(), int, span)?;
                                }
                                Domain::Text => {
                                    let text = text_type();
                                    self.constrain(arguments[0].clone(), text.clone(), span)?;
                                    self.constrain(arguments[1].clone(), text, span)?;
                                }
                                Domain::Float => {
                                    if name != "eq" && name != "ne" {
                                        let float = float_type();
                                        self.constrain(arguments[0].clone(), float.clone(), span)?;
                                        self.constrain(arguments[1].clone(), float, span)?;
                                    }
                                }
                                Domain::Float32 => {
                                    if name != "eq" && name != "ne" {
                                        let f32_ = float32_type();
                                        self.constrain(arguments[0].clone(), f32_.clone(), span)?;
                                        self.constrain(arguments[1].clone(), f32_, span)?;
                                    }
                                }
                            }
                        }
                    }
                    let parameter_type = if is_resolve_op {
'''
count = s.count(old)
if count < 1:
    raise SystemExit("resolver operator anchor not found")
p.write_text(s.replace(old, new, 1))
