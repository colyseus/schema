export class Player {
    x: number;
    y: number;
    hp: number;
    mp: number;
}

export class State {
    currentTurn: string = "";
    players: {[id: string]: Player} = {};
    map: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
}
