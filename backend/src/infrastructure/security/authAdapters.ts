import type { PasswordPort, TokenPort } from "../../application/ports/auth.js";
import { hashPasswordAsync, verifyPasswordAsync } from "../../lib/password.js";
import { signToken } from "../../lib/token.js";
import { AdmissionError } from '@nipopeto/runtime';
import { BusinessError } from '../../domain/error.js';

const admitted=async<T>(work:()=>Promise<T>)=>{try{return await work();}catch(error){if(error instanceof AdmissionError)throw new BusinessError(503,error.message);throw error;}};
export const passwordAdapter: PasswordPort = { hash: password=>admitted(()=>hashPasswordAsync(password)), verify: (password,hash,salt)=>admitted(()=>verifyPasswordAsync(password,hash,salt)) };
export const tokenAdapter: TokenPort = { sign: signToken };
