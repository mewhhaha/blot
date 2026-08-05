static ISLAND_0_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 2, target: 1, emit: IslandEmit { field: 26 } },
    IslandTransition { input_kind: InputKind::Island, input: 3, target: 2, emit: IslandEmit { field: 32 } },
    IslandTransition { input_kind: InputKind::Island, input: 5, target: 3, emit: IslandEmit { field: 12 } },
];

static ISLAND_0_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 3, target: 2, emit: IslandEmit { field: 32 } },
    IslandTransition { input_kind: InputKind::Island, input: 5, target: 3, emit: IslandEmit { field: 12 } },
];

static ISLAND_0_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 5, target: 3, emit: IslandEmit { field: 12 } },
];

static ISLAND_0_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 5, target: 3, emit: IslandEmit { field: 12 } },
];

static ISLAND_0_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_0_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_0_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_0_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_0_STATE_3_TRANSITIONS },
];

static ISLAND_1_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 12, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 13, target: 2, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 8, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 9, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_1_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_1_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_1_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_1_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_1_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_1_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_1_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_1_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_1_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_1_STATE_4_TRANSITIONS },
];

static ISLAND_2_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 14, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_2_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 2, emit: IslandEmit { field: 34 } },
];

static ISLAND_2_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_2_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_2_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_2_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_2_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_2_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_2_STATE_3_TRANSITIONS },
];

static ISLAND_3_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 16, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_3_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 17, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_3_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 4, target: 3, emit: IslandEmit { field: 12 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 18, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_3_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 4, target: 3, emit: IslandEmit { field: 12 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 18, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_3_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 5, emit: IslandEmit { field: -1 } },
];

static ISLAND_3_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_3_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_3_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_3_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_3_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_3_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_3_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_3_STATE_5_TRANSITIONS },
];

static ISLAND_4_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 19, target: 1, emit: IslandEmit { field: 5 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 20, target: 2, emit: IslandEmit { field: 5 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 21, target: 3, emit: IslandEmit { field: 5 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 22, target: 4, emit: IslandEmit { field: 5 } },
];

static ISLAND_4_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 3, target: 5, emit: IslandEmit { field: 38 } },
];

static ISLAND_4_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 3, target: 5, emit: IslandEmit { field: 38 } },
];

static ISLAND_4_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 3, target: 5, emit: IslandEmit { field: 38 } },
];

static ISLAND_4_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 3, target: 5, emit: IslandEmit { field: 38 } },
];

static ISLAND_4_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 23, target: 6, emit: IslandEmit { field: -1 } },
];

static ISLAND_4_STATE_6_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 1, target: 7, emit: IslandEmit { field: 31 } },
];

static ISLAND_4_STATE_7_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 24, target: 8, emit: IslandEmit { field: -1 } },
];

static ISLAND_4_STATE_8_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 25, target: 9, emit: IslandEmit { field: -1 } },
];

static ISLAND_4_STATE_9_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 70, target: 10, emit: IslandEmit { field: 54 } },
];

static ISLAND_4_STATE_10_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 11, emit: IslandEmit { field: -1 } },
];

static ISLAND_4_STATE_11_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_4_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_4_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_4_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_4_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_4_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_4_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_4_STATE_5_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_4_STATE_6_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_4_STATE_7_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_4_STATE_8_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_4_STATE_9_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_4_STATE_10_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_4_STATE_11_TRANSITIONS },
];

static ISLAND_5_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 10, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 12, target: 2, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 13, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 14, target: 4, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 58, target: 5, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 7, target: 6, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 9, target: 7, emit: IslandEmit { field: -1 } },
];

static ISLAND_5_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_5_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_5_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_5_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_5_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_5_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_5_STATE_7_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_5_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_5_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_5_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_5_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_5_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_5_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_5_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_5_STATE_6_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_5_STATE_7_TRANSITIONS },
];

static ISLAND_6_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 10, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 12, target: 2, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 13, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 14, target: 4, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 58, target: 5, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 7, target: 6, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 9, target: 7, emit: IslandEmit { field: -1 } },
];

static ISLAND_6_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_6_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_6_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_6_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_6_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_6_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_6_STATE_7_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_6_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_6_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_6_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_6_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_6_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_6_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_6_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_6_STATE_6_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_6_STATE_7_TRANSITIONS },
];

static ISLAND_7_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 8, target: 1, emit: IslandEmit { field: 52 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 26, target: 2, emit: IslandEmit { field: 28 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 27, target: 3, emit: IslandEmit { field: 28 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 28, target: 4, emit: IslandEmit { field: 28 } },
];

static ISLAND_7_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 8, target: 1, emit: IslandEmit { field: 52 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 26, target: 2, emit: IslandEmit { field: 28 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 27, target: 3, emit: IslandEmit { field: 28 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 28, target: 4, emit: IslandEmit { field: 28 } },
];

static ISLAND_7_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 5, emit: IslandEmit { field: 36 } },
];

static ISLAND_7_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 5, emit: IslandEmit { field: 36 } },
];

static ISLAND_7_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 5, emit: IslandEmit { field: 36 } },
];

static ISLAND_7_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 25, target: 6, emit: IslandEmit { field: -1 } },
];

static ISLAND_7_STATE_6_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 7, emit: IslandEmit { field: 55 } },
];

static ISLAND_7_STATE_7_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 8, emit: IslandEmit { field: -1 } },
];

static ISLAND_7_STATE_8_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_7_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_7_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_7_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_7_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_7_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_7_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_7_STATE_5_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_7_STATE_6_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_7_STATE_7_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_7_STATE_8_TRANSITIONS },
];

static ISLAND_8_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 29, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_8_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 30, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_8_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 3, emit: IslandEmit { field: 13 } },
];

static ISLAND_8_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 31, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_8_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_8_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_8_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_8_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_8_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_8_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_8_STATE_4_TRANSITIONS },
];

static ISLAND_9_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 1, target: 1, emit: IslandEmit { field: 30 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 2, emit: IslandEmit { field: 30 } },
];

static ISLAND_9_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 32, target: 3, emit: IslandEmit { field: 4 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 33, target: 4, emit: IslandEmit { field: 4 } },
];

static ISLAND_9_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 32, target: 3, emit: IslandEmit { field: 4 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 33, target: 4, emit: IslandEmit { field: 4 } },
];

static ISLAND_9_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 5, emit: IslandEmit { field: 55 } },
];

static ISLAND_9_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 5, emit: IslandEmit { field: 55 } },
];

static ISLAND_9_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 6, emit: IslandEmit { field: -1 } },
];

static ISLAND_9_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_9_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_9_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_9_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_9_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_9_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_9_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_9_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_9_STATE_6_TRANSITIONS },
];

static ISLAND_10_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 34, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_10_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 2, emit: IslandEmit { field: 25 } },
];

static ISLAND_10_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 11, target: 3, emit: IslandEmit { field: 14 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 35, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_10_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 35, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_10_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 5, emit: IslandEmit { field: 6 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 6, emit: IslandEmit { field: -1 } },
];

static ISLAND_10_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 5, emit: IslandEmit { field: 6 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 6, emit: IslandEmit { field: -1 } },
];

static ISLAND_10_STATE_6_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 7, emit: IslandEmit { field: -1 } },
];

static ISLAND_10_STATE_7_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_10_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_10_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_10_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_10_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_10_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_10_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_10_STATE_5_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_10_STATE_6_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_10_STATE_7_TRANSITIONS },
];

static ISLAND_11_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 37, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_11_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 2, emit: IslandEmit { field: 47 } },
];

static ISLAND_11_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_11_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_11_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_11_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_11_STATE_2_TRANSITIONS },
];

static ISLAND_12_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 38, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_12_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_12_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_12_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_12_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_12_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_12_STATE_2_TRANSITIONS },
];

static ISLAND_13_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 39, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_13_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 2, emit: IslandEmit { field: 55 } },
];

static ISLAND_13_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_13_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_13_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_13_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_13_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_13_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_13_STATE_3_TRANSITIONS },
];

static ISLAND_14_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 40, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_14_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 2, emit: IslandEmit { field: 55 } },
];

static ISLAND_14_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_14_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_14_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_14_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_14_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_14_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_14_STATE_3_TRANSITIONS },
];

static ISLAND_15_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 1, target: 1, emit: IslandEmit { field: 42 } },
    IslandTransition { input_kind: InputKind::Island, input: 16, target: 2, emit: IslandEmit { field: 55 } },
];

static ISLAND_15_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 16, target: 2, emit: IslandEmit { field: 55 } },
];

static ISLAND_15_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_15_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_15_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_15_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_15_STATE_2_TRANSITIONS },
];

static ISLAND_16_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 17, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 18, target: 2, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 19, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 20, target: 4, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 21, target: 5, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 22, target: 6, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 1, target: 7, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 8, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 3, target: 9, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 4, target: 10, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 5, target: 11, emit: IslandEmit { field: -1 } },
];

static ISLAND_16_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATE_7_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATE_8_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATE_9_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATE_10_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATE_11_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_16_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_16_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_6_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_7_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_8_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_9_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_10_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_16_STATE_11_TRANSITIONS },
];

static ISLAND_17_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 41, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_17_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 23, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_17_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 1, target: 3, emit: IslandEmit { field: 30 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 4, emit: IslandEmit { field: 30 } },
];

static ISLAND_17_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 24, target: 5, emit: IslandEmit { field: -1 } },
];

static ISLAND_17_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 24, target: 5, emit: IslandEmit { field: -1 } },
];

static ISLAND_17_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_17_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_17_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_17_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_17_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_17_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_17_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_17_STATE_5_TRANSITIONS },
];

static ISLAND_18_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 23, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_18_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 24, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_18_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_18_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_18_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_18_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_18_STATE_2_TRANSITIONS },
];

static ISLAND_19_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 23, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_19_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 2, emit: IslandEmit { field: 22 } },
];

static ISLAND_19_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 42, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_19_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 4, emit: IslandEmit { field: 43 } },
];

static ISLAND_19_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 24, target: 5, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 42, target: 6, emit: IslandEmit { field: 43 } },
];

static ISLAND_19_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_19_STATE_6_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 4, emit: IslandEmit { field: 43 } },
];

static ISLAND_19_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_19_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_19_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_19_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_19_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_19_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_19_STATE_5_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_19_STATE_6_TRANSITIONS },
];

static ISLAND_20_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 30, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_20_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 2, emit: IslandEmit { field: 17 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 31, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_20_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 31, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 42, target: 4, emit: IslandEmit { field: 17 } },
];

static ISLAND_20_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_20_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 2, emit: IslandEmit { field: 17 } },
];

static ISLAND_20_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_20_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_20_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_20_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_20_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_20_STATE_4_TRANSITIONS },
];

static ISLAND_21_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 41, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_21_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 2, emit: IslandEmit { field: 11 } },
];

static ISLAND_21_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 3, emit: IslandEmit { field: 37 } },
];

static ISLAND_21_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_21_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_21_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_21_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_21_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_21_STATE_3_TRANSITIONS },
];

static ISLAND_22_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 17, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_22_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 23, target: 2, emit: IslandEmit { field: 21 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 18, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_22_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 23, target: 2, emit: IslandEmit { field: 21 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 18, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_22_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_22_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_22_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_22_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_22_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_22_STATE_3_TRANSITIONS },
];

static ISLAND_23_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 43, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_23_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 31, target: 2, emit: IslandEmit { field: 30 } },
];

static ISLAND_23_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 25, target: 4, emit: IslandEmit { field: 55 } },
];

static ISLAND_23_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_23_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 5, emit: IslandEmit { field: 55 } },
];

static ISLAND_23_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_23_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_23_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_23_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_23_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_23_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_23_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_23_STATE_5_TRANSITIONS },
];

static ISLAND_24_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 26, target: 1, emit: IslandEmit { field: 22 } },
];

static ISLAND_24_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 25, target: 2, emit: IslandEmit { field: 43 } },
];

static ISLAND_24_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 25, target: 2, emit: IslandEmit { field: 43 } },
];

static ISLAND_24_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_24_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_24_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_24_STATE_2_TRANSITIONS },
];

static ISLAND_25_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 1, target: 1, emit: IslandEmit { field: 31 } },
];

static ISLAND_25_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 26, target: 2, emit: IslandEmit { field: 45 } },
];

static ISLAND_25_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_25_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_25_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_25_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_25_STATE_2_TRANSITIONS },
];

static ISLAND_26_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 27, target: 1, emit: IslandEmit { field: 39 } },
    IslandTransition { input_kind: InputKind::Island, input: 28, target: 2, emit: IslandEmit { field: 55 } },
];

static ISLAND_26_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 27, target: 1, emit: IslandEmit { field: 39 } },
    IslandTransition { input_kind: InputKind::Island, input: 28, target: 2, emit: IslandEmit { field: 55 } },
];

static ISLAND_26_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_26_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_26_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_26_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_26_STATE_2_TRANSITIONS },
];

static ISLAND_27_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 12, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 13, target: 2, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 44, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 45, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_27_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_27_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_27_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_27_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_27_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_27_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_27_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_27_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_27_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_27_STATE_4_TRANSITIONS },
];

static ISLAND_28_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 33, target: 1, emit: IslandEmit { field: 55 } },
];

static ISLAND_28_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 29, target: 2, emit: IslandEmit { field: 3 } },
    IslandTransition { input_kind: InputKind::Island, input: 30, target: 3, emit: IslandEmit { field: 51 } },
];

static ISLAND_28_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 29, target: 2, emit: IslandEmit { field: 3 } },
];

static ISLAND_28_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 29, target: 2, emit: IslandEmit { field: 3 } },
    IslandTransition { input_kind: InputKind::Island, input: 30, target: 3, emit: IslandEmit { field: 51 } },
];

static ISLAND_28_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_28_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_28_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_28_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_28_STATE_3_TRANSITIONS },
];

static ISLAND_29_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 35, target: 1, emit: IslandEmit { field: 55 } },
];

static ISLAND_29_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 30, target: 2, emit: IslandEmit { field: 51 } },
];

static ISLAND_29_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 30, target: 2, emit: IslandEmit { field: 51 } },
];

static ISLAND_29_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_29_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_29_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_29_STATE_2_TRANSITIONS },
];

static ISLAND_30_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 43, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_30_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 31, target: 2, emit: IslandEmit { field: 20 } },
];

static ISLAND_30_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_30_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_30_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_30_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_30_STATE_2_TRANSITIONS },
];

static ISLAND_31_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 32, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 1, target: 2, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 3, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_31_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_31_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_31_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_31_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_31_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_31_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_31_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_31_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_31_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_31_STATE_4_TRANSITIONS },
];

static ISLAND_32_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 14, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 16, target: 2, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 19, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 20, target: 4, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 21, target: 5, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 22, target: 6, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 26, target: 7, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 27, target: 8, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 28, target: 9, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 34, target: 10, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 35, target: 11, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 12, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 37, target: 13, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 38, target: 14, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 39, target: 15, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 40, target: 16, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 44, target: 17, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 45, target: 18, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 46, target: 19, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 47, target: 20, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 48, target: 21, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 49, target: 22, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 50, target: 23, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 51, target: 24, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 52, target: 25, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 53, target: 26, emit: IslandEmit { field: -1 } },
];

static ISLAND_32_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_7_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_8_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_9_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_10_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_11_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_12_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_13_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_14_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_15_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_16_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_17_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_18_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_19_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_20_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_21_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_22_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_23_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_24_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_25_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATE_26_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_32_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_32_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_6_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_7_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_8_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_9_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_10_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_11_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_12_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_13_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_14_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_15_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_16_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_17_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_18_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_19_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_20_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_21_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_22_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_23_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_24_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_25_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_32_STATE_26_TRANSITIONS },
];

static ISLAND_33_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 34, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 36, target: 2, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 37, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 38, target: 4, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 39, target: 5, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 41, target: 6, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 49, target: 7, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 55, target: 8, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 63, target: 9, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 66, target: 10, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 69, target: 11, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 1, target: 12, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 13, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 3, target: 14, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 4, target: 15, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 5, target: 16, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 7, target: 17, emit: IslandEmit { field: -1 } },
];

static ISLAND_33_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_7_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_8_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_9_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_10_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_11_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_12_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_13_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_14_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_15_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_16_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATE_17_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_33_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_33_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_6_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_7_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_8_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_9_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_10_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_11_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_12_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_13_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_14_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_15_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_16_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_33_STATE_17_TRANSITIONS },
];

static ISLAND_34_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 17, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_34_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 2, emit: IslandEmit { field: 16 } },
];

static ISLAND_34_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 18, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 42, target: 4, emit: IslandEmit { field: 16 } },
];

static ISLAND_34_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_34_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 2, emit: IslandEmit { field: 16 } },
];

static ISLAND_34_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_34_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_34_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_34_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_34_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_34_STATE_4_TRANSITIONS },
];

static ISLAND_35_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 36, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 37, target: 2, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 38, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 39, target: 4, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 49, target: 5, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 1, target: 6, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 7, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 3, target: 8, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 4, target: 9, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 5, target: 10, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 7, target: 11, emit: IslandEmit { field: -1 } },
];

static ISLAND_35_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATE_7_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATE_8_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATE_9_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATE_10_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATE_11_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_35_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_35_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_6_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_7_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_8_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_9_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_10_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_35_STATE_11_TRANSITIONS },
];

static ISLAND_36_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 41, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_36_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 2, emit: IslandEmit { field: 11 } },
];

static ISLAND_36_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_36_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_36_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_36_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_36_STATE_2_TRANSITIONS },
];

static ISLAND_37_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 23, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_37_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 24, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_37_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_37_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_37_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_37_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_37_STATE_2_TRANSITIONS },
];

static ISLAND_38_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 23, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_38_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 2, emit: IslandEmit { field: 22 } },
];

static ISLAND_38_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 24, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 42, target: 4, emit: IslandEmit { field: 53 } },
];

static ISLAND_38_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_38_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 5, emit: IslandEmit { field: 43 } },
];

static ISLAND_38_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 24, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 42, target: 6, emit: IslandEmit { field: 43 } },
];

static ISLAND_38_STATE_6_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 5, emit: IslandEmit { field: 43 } },
];

static ISLAND_38_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_38_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_38_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_38_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_38_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_38_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_38_STATE_5_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_38_STATE_6_TRANSITIONS },
];

static ISLAND_39_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 30, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_39_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 40, target: 2, emit: IslandEmit { field: 17 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 31, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_39_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 31, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 42, target: 4, emit: IslandEmit { field: 17 } },
];

static ISLAND_39_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_39_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 40, target: 2, emit: IslandEmit { field: 17 } },
];

static ISLAND_39_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_39_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_39_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_39_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_39_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_39_STATE_4_TRANSITIONS },
];

static ISLAND_40_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 1, emit: IslandEmit { field: 55 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 54, target: 2, emit: IslandEmit { field: 48 } },
];

static ISLAND_40_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_40_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 1, emit: IslandEmit { field: 55 } },
];

static ISLAND_40_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_40_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_40_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_40_STATE_2_TRANSITIONS },
];

static ISLAND_41_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 8, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_41_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 42, target: 2, emit: IslandEmit { field: 30 } },
];

static ISLAND_41_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 43, target: 3, emit: IslandEmit { field: 41 } },
    IslandTransition { input_kind: InputKind::Island, input: 46, target: 4, emit: IslandEmit { field: 18 } },
    IslandTransition { input_kind: InputKind::Island, input: 47, target: 5, emit: IslandEmit { field: 18 } },
];

static ISLAND_41_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 43, target: 3, emit: IslandEmit { field: 41 } },
    IslandTransition { input_kind: InputKind::Island, input: 46, target: 4, emit: IslandEmit { field: 18 } },
    IslandTransition { input_kind: InputKind::Island, input: 47, target: 5, emit: IslandEmit { field: 18 } },
];

static ISLAND_41_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_41_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_41_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_41_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_41_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_41_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_41_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_41_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_41_STATE_5_TRANSITIONS },
];

static ISLAND_42_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 1, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_42_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_42_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_42_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_42_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_42_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_42_STATE_2_TRANSITIONS },
];

static ISLAND_43_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 43, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_43_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 31, target: 2, emit: IslandEmit { field: 30 } },
];

static ISLAND_43_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 25, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_43_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 44, target: 4, emit: IslandEmit { field: 55 } },
];

static ISLAND_43_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_43_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_43_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_43_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_43_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_43_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_43_STATE_4_TRANSITIONS },
];

static ISLAND_44_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 36, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 37, target: 2, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 45, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 1, target: 4, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 5, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 3, target: 6, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 4, target: 7, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 5, target: 8, emit: IslandEmit { field: -1 } },
];

static ISLAND_44_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_44_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_44_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_44_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_44_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_44_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_44_STATE_7_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_44_STATE_8_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_44_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_44_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_44_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_44_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_44_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_44_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_44_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_44_STATE_6_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_44_STATE_7_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_44_STATE_8_TRANSITIONS },
];

static ISLAND_45_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 17, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_45_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 2, emit: IslandEmit { field: 55 } },
];

static ISLAND_45_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 18, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_45_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_45_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_45_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_45_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_45_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_45_STATE_3_TRANSITIONS },
];

static ISLAND_46_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 11, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_46_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_46_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_46_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_46_STATE_1_TRANSITIONS },
];

static ISLAND_47_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 9, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_47_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 2, emit: IslandEmit { field: 7 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 10, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_47_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 2, emit: IslandEmit { field: 7 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 10, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_47_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 42, target: 4, emit: IslandEmit { field: 8 } },
];

static ISLAND_47_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 9, target: 5, emit: IslandEmit { field: -1 } },
];

static ISLAND_47_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_47_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_47_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_47_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_47_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_47_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_47_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_47_STATE_5_TRANSITIONS },
];

static ISLAND_48_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 53, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_48_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_48_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_48_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_48_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_48_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_48_STATE_2_TRANSITIONS },
];

static ISLAND_49_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 17, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_49_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 50, target: 2, emit: IslandEmit { field: 29 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 18, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_49_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 50, target: 2, emit: IslandEmit { field: 29 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 18, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_49_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_49_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_49_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_49_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_49_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_49_STATE_3_TRANSITIONS },
];

static ISLAND_50_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 51, target: 1, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Island, input: 52, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_50_STATE_1_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_50_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_50_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_50_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_50_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_50_STATE_2_TRANSITIONS },
];

static ISLAND_51_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 54, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_51_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 2, emit: IslandEmit { field: 55 } },
];

static ISLAND_51_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_51_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_51_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_51_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_51_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_51_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_51_STATE_3_TRANSITIONS },
];

static ISLAND_52_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 43, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_52_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 31, target: 2, emit: IslandEmit { field: 30 } },
];

static ISLAND_52_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 12, target: 3, emit: IslandEmit { field: 33 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 25, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_52_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 25, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_52_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 5, emit: IslandEmit { field: 55 } },
];

static ISLAND_52_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 6, emit: IslandEmit { field: -1 } },
];

static ISLAND_52_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_52_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_52_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_52_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_52_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_52_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_52_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_52_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_52_STATE_6_TRANSITIONS },
];

static ISLAND_53_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 54, target: 1, emit: IslandEmit { field: 35 } },
];

static ISLAND_53_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 2, emit: IslandEmit { field: 6 } },
    IslandTransition { input_kind: InputKind::Island, input: 54, target: 1, emit: IslandEmit { field: 35 } },
];

static ISLAND_53_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_53_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_53_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_53_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_53_STATE_2_TRANSITIONS },
];

static ISLAND_54_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 53, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_54_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 2, emit: IslandEmit { field: 36 } },
];

static ISLAND_54_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 55, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_54_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_54_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_54_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_54_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_54_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_54_STATE_3_TRANSITIONS },
];

static ISLAND_55_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 46, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_55_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 2, emit: IslandEmit { field: 9 } },
];

static ISLAND_55_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 47, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_55_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 4, emit: IslandEmit { field: 10 } },
];

static ISLAND_55_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 56, target: 5, emit: IslandEmit { field: 2 } },
    IslandTransition { input_kind: InputKind::Island, input: 57, target: 6, emit: IslandEmit { field: 19 } },
];

static ISLAND_55_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 56, target: 5, emit: IslandEmit { field: 2 } },
    IslandTransition { input_kind: InputKind::Island, input: 57, target: 6, emit: IslandEmit { field: 19 } },
];

static ISLAND_55_STATE_6_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 7, emit: IslandEmit { field: -1 } },
];

static ISLAND_55_STATE_7_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_55_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_55_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_55_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_55_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_55_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_55_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_55_STATE_5_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_55_STATE_6_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_55_STATE_7_TRANSITIONS },
];

static ISLAND_56_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 6, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_56_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 2, emit: IslandEmit { field: 9 } },
];

static ISLAND_56_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 47, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_56_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 4, emit: IslandEmit { field: 10 } },
];

static ISLAND_56_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_56_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_56_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_56_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_56_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_56_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_56_STATE_4_TRANSITIONS },
];

static ISLAND_57_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 48, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_57_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 2, emit: IslandEmit { field: 1 } },
];

static ISLAND_57_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_57_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_57_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_57_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_57_STATE_2_TRANSITIONS },
];

static ISLAND_58_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 46, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_58_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 59, target: 2, emit: IslandEmit { field: 6 } },
    IslandTransition { input_kind: InputKind::Island, input: 60, target: 3, emit: IslandEmit { field: 6 } },
];

static ISLAND_58_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_58_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_58_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 5, emit: IslandEmit { field: -1 } },
];

static ISLAND_58_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_58_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_58_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_58_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_58_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_58_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_58_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_58_STATE_5_TRANSITIONS },
];

static ISLAND_59_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 26, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_59_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 2, emit: IslandEmit { field: 36 } },
];

static ISLAND_59_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 25, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_59_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 4, emit: IslandEmit { field: 55 } },
];

static ISLAND_59_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 48, target: 5, emit: IslandEmit { field: -1 } },
];

static ISLAND_59_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 6, emit: IslandEmit { field: 1 } },
];

static ISLAND_59_STATE_6_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 6, emit: IslandEmit { field: 1 } },
];

static ISLAND_59_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_59_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_59_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_59_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_59_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_59_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_59_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_59_STATE_6_TRANSITIONS },
];

static ISLAND_60_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 1, emit: IslandEmit { field: 9 } },
];

static ISLAND_60_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 47, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_60_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 3, emit: IslandEmit { field: 10 } },
    IslandTransition { input_kind: InputKind::Island, input: 61, target: 4, emit: IslandEmit { field: 2 } },
    IslandTransition { input_kind: InputKind::Island, input: 62, target: 5, emit: IslandEmit { field: 19 } },
];

static ISLAND_60_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 3, emit: IslandEmit { field: 10 } },
    IslandTransition { input_kind: InputKind::Island, input: 61, target: 4, emit: IslandEmit { field: 2 } },
    IslandTransition { input_kind: InputKind::Island, input: 62, target: 5, emit: IslandEmit { field: 19 } },
];

static ISLAND_60_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 61, target: 4, emit: IslandEmit { field: 2 } },
    IslandTransition { input_kind: InputKind::Island, input: 62, target: 5, emit: IslandEmit { field: 19 } },
];

static ISLAND_60_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_60_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_60_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_60_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_60_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_60_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_60_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_60_STATE_5_TRANSITIONS },
];

static ISLAND_61_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 6, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_61_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 2, emit: IslandEmit { field: 9 } },
];

static ISLAND_61_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 47, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_61_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 4, emit: IslandEmit { field: 10 } },
];

static ISLAND_61_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 4, emit: IslandEmit { field: 10 } },
];

static ISLAND_61_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_61_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_61_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_61_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_61_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_61_STATE_4_TRANSITIONS },
];

static ISLAND_62_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 48, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_62_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 2, emit: IslandEmit { field: 1 } },
];

static ISLAND_62_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 2, emit: IslandEmit { field: 1 } },
];

static ISLAND_62_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_62_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_62_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_62_STATE_2_TRANSITIONS },
];

static ISLAND_63_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 49, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_63_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 2, emit: IslandEmit { field: 54 } },
];

static ISLAND_63_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 50, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_63_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 64, target: 4, emit: IslandEmit { field: 22 } },
];

static ISLAND_63_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 5, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 42, target: 6, emit: IslandEmit { field: 43 } },
];

static ISLAND_63_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_63_STATE_6_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 64, target: 7, emit: IslandEmit { field: 43 } },
];

static ISLAND_63_STATE_7_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 5, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 42, target: 6, emit: IslandEmit { field: 43 } },
];

static ISLAND_63_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_63_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_63_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_63_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_63_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_63_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_63_STATE_5_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_63_STATE_6_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_63_STATE_7_TRANSITIONS },
];

static ISLAND_64_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 15, target: 1, emit: IslandEmit { field: 36 } },
];

static ISLAND_64_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 65, target: 2, emit: IslandEmit { field: 23 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 55, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_64_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 55, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_64_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 4, emit: IslandEmit { field: 6 } },
];

static ISLAND_64_STATE_4_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_64_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_64_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_64_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_64_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_64_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_64_STATE_4_TRANSITIONS },
];

static ISLAND_65_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 46, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_65_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 24, target: 2, emit: IslandEmit { field: 9 } },
];

static ISLAND_65_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_65_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_65_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_65_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_65_STATE_2_TRANSITIONS },
];

static ISLAND_66_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 51, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_66_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 2, emit: IslandEmit { field: 40 } },
];

static ISLAND_66_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 52, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_66_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 67, target: 4, emit: IslandEmit { field: 50 } },
    IslandTransition { input_kind: InputKind::Island, input: 68, target: 5, emit: IslandEmit { field: 44 } },
];

static ISLAND_66_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 67, target: 4, emit: IslandEmit { field: 50 } },
    IslandTransition { input_kind: InputKind::Island, input: 68, target: 5, emit: IslandEmit { field: 44 } },
];

static ISLAND_66_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 6, emit: IslandEmit { field: -1 } },
];

static ISLAND_66_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_66_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_66_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_66_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_66_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_66_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_66_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_66_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_66_STATE_6_TRANSITIONS },
];

static ISLAND_67_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 1, target: 1, emit: IslandEmit { field: 30 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 2, emit: IslandEmit { field: 30 } },
];

static ISLAND_67_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 33, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_67_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 33, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_67_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 68, target: 4, emit: IslandEmit { field: 0 } },
];

static ISLAND_67_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 15, target: 5, emit: IslandEmit { field: -1 } },
];

static ISLAND_67_STATE_5_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_67_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_67_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_67_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_67_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_67_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_67_STATE_4_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_67_STATE_5_TRANSITIONS },
];

static ISLAND_68_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 7, target: 1, emit: IslandEmit { field: 27 } },
];

static ISLAND_68_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 23, target: 2, emit: IslandEmit { field: -1 } },
];

static ISLAND_68_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 3, emit: IslandEmit { field: 15 } },
];

static ISLAND_68_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 42, target: 4, emit: IslandEmit { field: -1 } },
];

static ISLAND_68_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 5, emit: IslandEmit { field: 24 } },
];

static ISLAND_68_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 24, target: 6, emit: IslandEmit { field: -1 } },
];

static ISLAND_68_STATE_6_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_68_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_68_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_68_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_68_STATE_2_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_68_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_68_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_68_STATE_5_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_68_STATE_6_TRANSITIONS },
];

static ISLAND_69_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 35, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_69_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 2, emit: IslandEmit { field: 49 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 37, target: 4, emit: IslandEmit { field: 44 } },
];

static ISLAND_69_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 6, target: 2, emit: IslandEmit { field: 49 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 3, emit: IslandEmit { field: -1 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 37, target: 4, emit: IslandEmit { field: 44 } },
];

static ISLAND_69_STATE_3_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_69_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 48, target: 5, emit: IslandEmit { field: 44 } },
];

static ISLAND_69_STATE_5_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 36, target: 3, emit: IslandEmit { field: -1 } },
];

static ISLAND_69_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_69_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_69_STATE_1_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_69_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_69_STATE_3_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_69_STATE_4_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_69_STATE_5_TRANSITIONS },
];

static ISLAND_70_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 1, target: 1, emit: IslandEmit { field: 46 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 2, target: 2, emit: IslandEmit { field: 46 } },
    IslandTransition { input_kind: InputKind::Terminal, input: 7, target: 3, emit: IslandEmit { field: 46 } },
];

static ISLAND_70_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 71, target: 4, emit: IslandEmit { field: 43 } },
];

static ISLAND_70_STATE_2_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 71, target: 4, emit: IslandEmit { field: 43 } },
];

static ISLAND_70_STATE_3_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 71, target: 4, emit: IslandEmit { field: 43 } },
];

static ISLAND_70_STATE_4_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 71, target: 4, emit: IslandEmit { field: 43 } },
];

static ISLAND_70_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_70_STATE_0_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_70_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_70_STATE_2_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_70_STATE_3_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_70_STATE_4_TRANSITIONS },
];

static ISLAND_71_STATE_0_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Terminal, input: 43, target: 1, emit: IslandEmit { field: -1 } },
];

static ISLAND_71_STATE_1_TRANSITIONS: &[IslandTransition] = &[
    IslandTransition { input_kind: InputKind::Island, input: 31, target: 2, emit: IslandEmit { field: 30 } },
];

static ISLAND_71_STATE_2_TRANSITIONS: &[IslandTransition] = &[

];

static ISLAND_71_STATES: &[IslandState] = &[
    IslandState { accepting: false, transitions: ISLAND_71_STATE_0_TRANSITIONS },
    IslandState { accepting: false, transitions: ISLAND_71_STATE_1_TRANSITIONS },
    IslandState { accepting: true, transitions: ISLAND_71_STATE_2_TRANSITIONS },
];

static ISLANDS: &[Island] = &[
    Island { rule_id: 1, start_state: 0, states: ISLAND_0_STATES },
    Island { rule_id: 0, start_state: 0, states: ISLAND_1_STATES },
    Island { rule_id: 2, start_state: 0, states: ISLAND_2_STATES },
    Island { rule_id: 3, start_state: 0, states: ISLAND_3_STATES },
    Island { rule_id: 4, start_state: 0, states: ISLAND_4_STATES },
    Island { rule_id: 5, start_state: 0, states: ISLAND_5_STATES },
    Island { rule_id: 6, start_state: 0, states: ISLAND_6_STATES },
    Island { rule_id: 7, start_state: 0, states: ISLAND_7_STATES },
    Island { rule_id: 8, start_state: 0, states: ISLAND_8_STATES },
    Island { rule_id: 9, start_state: 0, states: ISLAND_9_STATES },
    Island { rule_id: 10, start_state: 0, states: ISLAND_10_STATES },
    Island { rule_id: 11, start_state: 0, states: ISLAND_11_STATES },
    Island { rule_id: 12, start_state: 0, states: ISLAND_12_STATES },
    Island { rule_id: 13, start_state: 0, states: ISLAND_13_STATES },
    Island { rule_id: 14, start_state: 0, states: ISLAND_14_STATES },
    Island { rule_id: 15, start_state: 0, states: ISLAND_15_STATES },
    Island { rule_id: 16, start_state: 0, states: ISLAND_16_STATES },
    Island { rule_id: 17, start_state: 0, states: ISLAND_17_STATES },
    Island { rule_id: 18, start_state: 0, states: ISLAND_18_STATES },
    Island { rule_id: 19, start_state: 0, states: ISLAND_19_STATES },
    Island { rule_id: 20, start_state: 0, states: ISLAND_20_STATES },
    Island { rule_id: 21, start_state: 0, states: ISLAND_21_STATES },
    Island { rule_id: 22, start_state: 0, states: ISLAND_22_STATES },
    Island { rule_id: 23, start_state: 0, states: ISLAND_23_STATES },
    Island { rule_id: 24, start_state: 0, states: ISLAND_24_STATES },
    Island { rule_id: 25, start_state: 0, states: ISLAND_25_STATES },
    Island { rule_id: 26, start_state: 0, states: ISLAND_26_STATES },
    Island { rule_id: 27, start_state: 0, states: ISLAND_27_STATES },
    Island { rule_id: 28, start_state: 0, states: ISLAND_28_STATES },
    Island { rule_id: 29, start_state: 0, states: ISLAND_29_STATES },
    Island { rule_id: 30, start_state: 0, states: ISLAND_30_STATES },
    Island { rule_id: 31, start_state: 0, states: ISLAND_31_STATES },
    Island { rule_id: 32, start_state: 0, states: ISLAND_32_STATES },
    Island { rule_id: 33, start_state: 0, states: ISLAND_33_STATES },
    Island { rule_id: 34, start_state: 0, states: ISLAND_34_STATES },
    Island { rule_id: 35, start_state: 0, states: ISLAND_35_STATES },
    Island { rule_id: 36, start_state: 0, states: ISLAND_36_STATES },
    Island { rule_id: 37, start_state: 0, states: ISLAND_37_STATES },
    Island { rule_id: 38, start_state: 0, states: ISLAND_38_STATES },
    Island { rule_id: 39, start_state: 0, states: ISLAND_39_STATES },
    Island { rule_id: 40, start_state: 0, states: ISLAND_40_STATES },
    Island { rule_id: 41, start_state: 0, states: ISLAND_41_STATES },
    Island { rule_id: 42, start_state: 0, states: ISLAND_42_STATES },
    Island { rule_id: 43, start_state: 0, states: ISLAND_43_STATES },
    Island { rule_id: 44, start_state: 0, states: ISLAND_44_STATES },
    Island { rule_id: 45, start_state: 0, states: ISLAND_45_STATES },
    Island { rule_id: 46, start_state: 0, states: ISLAND_46_STATES },
    Island { rule_id: 47, start_state: 0, states: ISLAND_47_STATES },
    Island { rule_id: 48, start_state: 0, states: ISLAND_48_STATES },
    Island { rule_id: 49, start_state: 0, states: ISLAND_49_STATES },
    Island { rule_id: 50, start_state: 0, states: ISLAND_50_STATES },
    Island { rule_id: 51, start_state: 0, states: ISLAND_51_STATES },
    Island { rule_id: 52, start_state: 0, states: ISLAND_52_STATES },
    Island { rule_id: 53, start_state: 0, states: ISLAND_53_STATES },
    Island { rule_id: 54, start_state: 0, states: ISLAND_54_STATES },
    Island { rule_id: 55, start_state: 0, states: ISLAND_55_STATES },
    Island { rule_id: 56, start_state: 0, states: ISLAND_56_STATES },
    Island { rule_id: 57, start_state: 0, states: ISLAND_57_STATES },
    Island { rule_id: 58, start_state: 0, states: ISLAND_58_STATES },
    Island { rule_id: 59, start_state: 0, states: ISLAND_59_STATES },
    Island { rule_id: 60, start_state: 0, states: ISLAND_60_STATES },
    Island { rule_id: 61, start_state: 0, states: ISLAND_61_STATES },
    Island { rule_id: 62, start_state: 0, states: ISLAND_62_STATES },
    Island { rule_id: 63, start_state: 0, states: ISLAND_63_STATES },
    Island { rule_id: 64, start_state: 0, states: ISLAND_64_STATES },
    Island { rule_id: 65, start_state: 0, states: ISLAND_65_STATES },
    Island { rule_id: 66, start_state: 0, states: ISLAND_66_STATES },
    Island { rule_id: 67, start_state: 0, states: ISLAND_67_STATES },
    Island { rule_id: 68, start_state: 0, states: ISLAND_68_STATES },
    Island { rule_id: 69, start_state: 0, states: ISLAND_69_STATES },
    Island { rule_id: 70, start_state: 0, states: ISLAND_70_STATES },
    Island { rule_id: 71, start_state: 0, states: ISLAND_71_STATES },
];

static BOUNDARIES: &[Boundary] = &[
    Boundary::Root,
    Boundary::Root,
    Boundary::Terminated { _terminal: 15 },
    Boundary::Terminated { _terminal: 15 },
    Boundary::Root,
    Boundary::Terminated { _terminal: 15 },
    Boundary::Terminated { _terminal: 15 },
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Paired { open_terminal: 23, close_terminal: 24 },
    Boundary::Separated { open_terminal: 30, close_terminal: 31, _separator_terminal: 42 },
    Boundary::Root,
    Boundary::Paired { open_terminal: 17, close_terminal: 18 },
    Boundary::Terminated { _terminal: 15 },
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Separated { open_terminal: 17, close_terminal: 18, _separator_terminal: 42 },
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Paired { open_terminal: 23, close_terminal: 24 },
    Boundary::Separated { open_terminal: 30, close_terminal: 31, _separator_terminal: 42 },
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Paired { open_terminal: 17, close_terminal: 18 },
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Terminated { _terminal: 36 },
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Root,
    Boundary::Terminated { _terminal: 36 },
    Boundary::Root,
    Boundary::Root,
    Boundary::Terminated { _terminal: 36 },
    Boundary::Root,
    Boundary::Root,
    Boundary::Terminated { _terminal: 36 },
    Boundary::Root,
    Boundary::Root,
];

static TERMINAL_CLASSIFICATION: &[i32] = &[
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, -1, -1, 14,
    15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46,
    47, 48, 49, 50, 51, 52, 53, 54, 55,
];

static ASCII_TRANSITIONS: &[i32] = &[
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 1, -1, -1, 1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    1, 2, 3, 4, 2, 2, 2, -1, 5, 6, 2, 2, 7, 2, 8, 9,
    10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18,
    18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 19, 2, 20, 2, 21,
    -1, 21, 22, 23, 24, 25, 26, 21, 21, 27, 21, 21, 28, 29, 21, 30,
    31, 21, 32, 33, 34, 21, 21, 35, 21, 21, 21, 36, 2, 37, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 1, -1, -1, 1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, 2, -1, -1, 2, 2, 2, -1, -1, -1, 2, 2, -1, 2, -1, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, 2, 2, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 38, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 39, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 40, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, 2, -1, -1, 2, 2, 2, -1, -1, -1, 2, 2, -1, 2, -1, 41,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, 2, 42, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 43, -1,
    10, 10, 10, 10, 10, 10, 10, 10, 10, 10, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, 2, -1, -1, 2, 2, 2, -1, -1, -1, 2, 2, -1, 2, -1, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, 44, 2, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, 2, -1, -1, 2, 2, 2, -1, -1, -1, 2, 2, -1, 45, -1, 46,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, 2, 2, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, 2, -1, -1, 2, 2, 2, -1, -1, -1, 2, 2, -1, 2, -1, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, 2, 47, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, 2, -1, -1, 2, 2, 2, -1, -1, -1, 2, 2, -1, 2, -1, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, -1, 2, 2, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, 2, -1, -1, 2, 2, 2, -1, -1, -1, 2, 2, -1, 2, -1, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, 2, 2, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 48,
    -1, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
    48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    18, 18, 18, 18, 18, 18, 18, 18, 18, 18, -1, -1, -1, -1, -1, -1,
    -1, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18,
    18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, -1, -1, -1, -1, 18,
    -1, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18,
    18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 49, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 50, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 51,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 52,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 53, 21, 54, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 55, 56,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 57, 21, 21, 21, 21, 21, 21, 21, 58, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 59, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 60,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 61, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    62, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 63, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 64, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 65, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 66, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 67, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 68, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, 3, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3, -1,
    -1, -1, 3, -1, 3, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 69, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    41, 41, 41, 41, 41, 41, 41, 41, 41, 41, -1, 41, 41, -1, 41, 41,
    41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
    41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
    41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
    41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
    41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
    41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
    41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    70, 70, 70, 70, 70, 70, 70, 70, 70, 70, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, 2, -1, -1, 2, 2, 2, -1, -1, -1, 2, 2, -1, 2, -1, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, 2, 2, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, 2, -1, -1, 2, 2, 2, -1, -1, -1, 2, 2, -1, 2, -1, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, 2, 2, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, 2, -1, -1, 2, 2, 2, -1, -1, -1, 2, 2, -1, 2, -1, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, 2, 2, 2,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, -1, 2, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 71, -1,
    48, 48, 48, 48, 48, 48, 48, 48, 48, 48, -1, -1, -1, -1, -1, -1,
    -1, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
    48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, -1, -1, -1, -1, 48,
    -1, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
    48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 72, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 73, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 74, 75, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 76, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 77, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 78, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 79, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 80, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 81, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 82, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 83, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 84, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 85, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 86, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 87, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 88, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 89, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    70, 70, 70, 70, 70, 70, 70, 70, 70, 70, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 48,
    -1, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
    48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 90, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 91, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    92, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 93, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 94, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 95, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 96, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 97, 21,
    21, 21, 98, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 99, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 100, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 101, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 102, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 103, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 104, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 105, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 106, 106, -1, -1, 106, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    106, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 107, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 108, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 109, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 110, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 111, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 112, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 106, 106, -1, -1, 106, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    106, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, 113, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 114, 21, 21, 21,
    21, 21, 115, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 116, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 117, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 118, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 119, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 120, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, 121, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 122,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 123, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 124, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 125, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1, -1,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, 21,
    -1, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, -1, -1, -1, -1, -1,
];

static TRANSITION_ROWS: &[i32] = &[
    0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
];

static TRANSITIONS: &[i32] = &[
    128, 1114111, 3, 128, 1114111, 41,
];

static ACCEPT_SPEC_BY_STATE: &[i32] = &[
    -1, 13, 12, -1, 42, 24, 25, 43, 44, 12, 2, 12, 16, 7, 26, 8,
    11, 30, 1, 31, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 18, 19, 4, -1, -1, 14, 10, -1, 33, 34, 9, 56,
    6, 0, 0, 0, 36, 0, 0, 54, 0, 47, 38, 0, 0, 51, 0, 0,
    0, 0, 0, 0, 0, 55, 3, -1, 0, 0, 0, 0, 0, 37, 35, 0,
    27, 0, 0, 0, 46, 0, 29, 0, 52, 0, 0, 50, 0, 0, 49, 0,
    0, 40, 0, 0, 0, 48, 53, 39, 0, 28, -1, 22, 0, 0, 0, 0,
    0, -1, 20, 21, 15, 0, 23, 41, 0, 5, 0, 45, 0, 17,
];

static GENERATED_FRONTEND_PLAN: FrontendPlan = FrontendPlan {
    root_island: 0,
    terminal_classification: TERMINAL_CLASSIFICATION,
    boundaries: BOUNDARIES,
    islands: ISLANDS,
    lexer: Lexer {
        state_count: 126,
        start_state: 0,
        ascii_transitions: ASCII_TRANSITIONS,
        transition_rows: TRANSITION_ROWS,
        transitions: TRANSITIONS,
        accept_spec_by_state: ACCEPT_SPEC_BY_STATE,
    },
};
