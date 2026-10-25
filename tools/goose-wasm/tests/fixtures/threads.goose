thread_fn worker() { print("worker"); }

fn main() { thread_wait(thread_spawn(worker)); }
