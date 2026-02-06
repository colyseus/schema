//
// This is a copy of helper from @colyseus/core 0.17
//
type ExtractClientUserData<T> = T extends { userData: infer U } ? U : T;
type ExtractClientAuth<T> = T extends { auth: infer A } ? A : any;
type ExtractClientMessages<T> = T extends { messages: infer M } ? M : any;
export interface Client<T extends { userData?: any, auth?: any, messages?: Record<string | number, any> } = any> {
    '~messages': ExtractClientMessages<T>;
    userData?: ExtractClientUserData<T>;
    auth?: ExtractClientAuth<T>;
}

interface IRoomMetadata {
    mode: string;
}

interface IRoomCache {
    name: string;
    metadata: IRoomMetadata;
}

//
// TODO: we should be able to generate message types for all SDKs
//
type LobbyClient = Client<{
    messages: {
        rooms: IRoomCache[];
        '+': [roomId: string, room: IRoomCache];
        '-': string;
    }
}>;