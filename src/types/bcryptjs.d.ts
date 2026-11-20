// bcryptjs 2.x has no bundled TypeScript declarations. Keep types local
// rather than installing the deprecated @types/bcryptjs tarball.
declare module "bcryptjs" {
  interface BcryptJs {
    hash(password: string, rounds: number): Promise<string>;
    compare(password: string, hash: string): Promise<boolean>;
  }
  const bcrypt: BcryptJs;
  export = bcrypt;
}
